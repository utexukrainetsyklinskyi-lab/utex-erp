from django.shortcuts import render
from django.http import JsonResponse
from django.contrib.auth.decorators import login_required
from django.views.decorators.http import require_POST
from django.views.decorators.csrf import ensure_csrf_cookie
from django.utils import timezone
from django.utils.html import escape
from datetime import datetime, timedelta
import json

from .models import WorkCenter, ProductionPlan, ProductRouting, Specification

@login_required(login_url='admin:login')
@ensure_csrf_cookie
def gantt_monitor_view(request):
    """Відображає сторінку інтерактивного монітора ліній"""
    return render(request, 'workspace/gantt.html', {'section': 'gantt', 'title': 'Графік ліній'})


@login_required(login_url='admin:login')
def gantt_data_api(request):
    """API-ендпоінт, який віддає дані для таймлайну (vis-timeline)"""
    centers = WorkCenter.objects.filter(is_active=True)
    groups = [{'id': c.id, 'content': f"{escape(c.name)} ({escape(c.code)})"} for c in centers]
        
    # Використовуємо select_related для оптимізації запитів до БД (уникаємо N+1)
    plans = ProductionPlan.objects.exclude(status='completed').select_related('order', 'product')
    items = []
    
    for plan in plans:
        if plan.work_center_id and plan.planned_start and plan.planned_end:
            css_class = 'gantt-order-item' if plan.status == 'queued' else 'gantt-order-item-progress'
            
            # === ГЕНЕРАЦІЯ МІТКИ ГОТОВНОСТІ ПЕРШОГО БАРАБАНА ===
            marker_html = ""
            drum_length = plan.order.length_per_drum
            order_qty = plan.order.quantity
            
            # Якщо вказана довжина на тарі і вона менша за загальну кількість в замовленні
            if drum_length and order_qty and 0 < drum_length < order_qty:
                # Вираховуємо відсоток готовності першого барабана
                percent_ready = (drum_length / order_qty) * 100
                
                # Створюємо зелену лінію як HTML елемент (абсолютно спозиційований відносно блоку)
                marker_html = f"""
                <div style="position: absolute; left: {percent_ready}%; top: 0; bottom: 0; 
                            width: 3px; background-color: #00ff00; z-index: 1; 
                            box-shadow: 1px 0 3px rgba(0,0,0,0.4);">
                </div>
                """

            # Основний текст обгортаємо, щоб він був поверх мітки
            text_content = f"""
            <div style="position: relative; z-index: 2; padding: 2px 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                Зам №{escape(plan.order.order_number)} ➔ {escape(plan.product.name)} ({plan.quantity_needed} {escape(plan.product.unit)})
            </div>
            """
            
            items.append({
                'id': plan.id,
                'group': plan.work_center_id,
                # Комбінуємо мітку та текст у полі content
                'content': f"{marker_html}{text_content}",
                'start': plan.planned_start.isoformat(),
                'end': plan.planned_end.isoformat(),
                'className': css_class
            })
            
    return JsonResponse({'groups': groups, 'items': items})


@login_required(login_url='admin:login')
@require_POST
def gantt_update_api(request):
    """API-ендпоінт для збереження змін у БД після перетягування (Drag-and-Drop)"""
    try:
        data = json.loads(request.body)
        plan_id = data.get('id')
        new_work_center_id = data.get('group')
        start_str = data.get('start')
        
        plan = ProductionPlan.objects.get(id=plan_id)
        work_center = WorkCenter.objects.get(id=new_work_center_id)
        
        planned_start_dt = datetime.fromisoformat(start_str.replace('Z', '+00:00'))
        if timezone.is_naive(planned_start_dt):
            planned_start_dt = timezone.make_aware(planned_start_dt, timezone.get_default_timezone())

        # =========================================================
        # ПРАВИЛО 1: Валідація технологічного маршруту
        # =========================================================
        route = ProductRouting.objects.filter(
            product=plan.product,
            work_center=work_center
        ).first()
        
        if not route:
            return JsonResponse({
                'status': 'error', 
                'message': f"Помилка технології: Для {plan.product.name} відсутній маршрут на лінії {work_center.code}."
            })

        # =========================================================
        # ПРАВИЛО 3: Перевірка готовності напівфабрикатів (Облік будівельної довжини)
        # =========================================================
        specs = Specification.objects.filter(product=plan.product)
        
        for spec in specs:
            ingredient = spec.ingredient
            
            # Шукаємо план на цей напівфабрикат у цьому ж замовленні
            dep_plan = ProductionPlan.objects.filter(
                order=plan.order,
                product=ingredient,
                planned_start__isnull=False
            ).first()
            
            if dep_plan:
                # 1. Визначаємо будівельну довжину (кількість на 1 барабан)
                drum_length = plan.order.length_per_drum
                if not drum_length or drum_length <= 0:
                    drum_length = plan.quantity_needed  # Якщо тари немає, беремо всю партію
                
                # 2. Визначаємо необхідний об'єм напівфабрикату для 1 барабана
                req_ingredient_for_drum = drum_length * spec.quantity
                
                # Запобіжник: щоб ми не вимагали більше, ніж взагалі заплановано виробити
                req_ingredient_for_drum = min(req_ingredient_for_drum, dep_plan.quantity_needed)

                # 3. Вираховуємо час готовності першої партії (будівельної довжини)
                dep_route = ProductRouting.objects.filter(
                    product=dep_plan.product,
                    work_center=dep_plan.work_center
                ).first()

                if dep_route and dep_route.speed_m_per_min > 0:
                    # Хвилин = (Кілометри * 1000) / Швидкість м/хв
                    mins_to_first_batch = (req_ingredient_for_drum * 1000.0) / float(dep_route.speed_m_per_min)
                    min_allowed_start = dep_plan.planned_start + timedelta(minutes=mins_to_first_batch)
                else:
                    # Якщо швидкість невідома, надійно чекаємо кінця етапу
                    min_allowed_start = dep_plan.planned_end or (dep_plan.planned_start + timedelta(hours=2))

                # 4. Валідація: чи не ставимо ми поточний план раніше, ніж з'явиться перший барабан напівфабрикату?
                if planned_start_dt < min_allowed_start:
                    return JsonResponse({
                        'status': 'error',
                        'message': (f"Порушення послідовності!\nДля старту потрібно мінімум {req_ingredient_for_drum:.2f} {ingredient.unit} "
                                    f"напівфабрикату '{ingredient.name}'.\nЦей об'єм буде напрацьовано лише "
                                    f"{timezone.localtime(min_allowed_start).strftime('%d.%m %H:%M')}.")
                    })

        # =========================================================
        # ПРАВИЛО 2: Автоматичний розрахунок часу (за швидкістю м/хв)
        # =========================================================
        speed = route.speed_m_per_min
        
        if speed > 0:
            total_minutes = (float(plan.quantity_needed) * 1000.0) / float(speed)
            duration_hours = total_minutes / 60.0
            planned_end_dt = planned_start_dt + timedelta(minutes=total_minutes)
        else:
            duration_hours = 2.0
            planned_end_dt = planned_start_dt + timedelta(hours=2)

        # Зберігаємо оновлені дані
        plan.work_center = work_center
        plan.planned_start = planned_start_dt
        plan.planned_end = planned_end_dt
        plan.duration_hours = round(duration_hours, 2)
        plan.save()
        
        return JsonResponse({
            'status': 'success', 
            'new_end': planned_end_dt.isoformat()
        })
        
    except ProductionPlan.DoesNotExist:
        return JsonResponse({'status': 'error', 'message': 'Запис у плані не знайдено.'})
    except WorkCenter.DoesNotExist:
        return JsonResponse({'status': 'error', 'message': 'Обладнання не знайдено.'})
    except Exception as e:
        return JsonResponse({'status': 'error', 'message': f"Помилка сервера: {str(e)}"})
