from django.db import models
from django.db.models import Sum
from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver

# === АВТОМАТИЧНЕ СТВОРЕННЯ АРТИКУЛІВ ===
def generate_next_sku():
    """
    Автоматично знаходить останній числовий артикул у базі 
    і генерує наступний за порядком (наприклад: 000001 -> 000002)
    """
    try:
        last_item = Nomenclature.objects.exclude(sku='').order_by('-id').first()
        if last_item and last_item.sku.isdigit():
            next_number = int(last_item.sku) + 1
            return f"{next_number:06d}"
        elif last_item:
            return f"{last_item.id + 1:06d}"
        return "000001"
    except Exception:
        return "000001"


class Client(models.Model):
    name = models.CharField("Назва компанії / Клієнт", max_length=255)
    phone = models.CharField("Телефон", max_length=20, blank=True, default="")
    email = models.EmailField("Email", blank=True, default="")

    class Meta:
        verbose_name = "Клієнт"
        verbose_name_plural = "Клієнти"

    def __str__(self):
        return self.name


class Nomenclature(models.Model):
    ITEM_TYPE_CHOICES = [
        ('product', 'Готова продукція (Кабель)'),
        ('half_product', 'Напівфабрикат (Оптичний модуль)'),
        ('material', 'Матеріал (Волокно/Дріт/Пластикат)'),
    ]
    sku = models.CharField("Артикул / SKU", max_length=100, unique=True, default=generate_next_sku)
    name = models.CharField("Назва номенклатури", max_length=255)
    item_type = models.CharField("Тип номенклатури", max_length=20, choices=ITEM_TYPE_CHOICES)
    unit = models.CharField("Одиниця виміру", max_length=20, default="км")
    
    structure_sku = models.CharField("Артикул Конструкції", max_length=100, blank=True, help_text="Унікальний ідентифікатор креслення для кожної конструкції")
    fiber_count = models.IntegerField("Кількість оптичних волокон (ОВ)", default=0, help_text="Значення для розрахунку приведеного кілометра")

    class Meta:
        verbose_name = "Номенклатура"
        verbose_name_plural = "Номенклатура"

    def __str__(self):
        if self.structure_sku:
            return f"{self.name} [{self.structure_sku}]"
        return self.name


class Specification(models.Model):
    product = models.ForeignKey(Nomenclature, on_delete=models.CASCADE, related_name='specifications', verbose_name="Основна конструкція")
    ingredient = models.ForeignKey(Nomenclature, on_delete=models.CASCADE, related_name='used_in_specs', verbose_name="Компонент / Матеріал")
    quantity = models.FloatField("Норма витрати на од. виміру")

    class Meta:
        verbose_name = "Компонент специфікації"
        verbose_name_plural = "Склад構造ції (Специфікації)"

    def __str__(self):
        return f"{self.ingredient.name} -> {self.quantity} {self.ingredient.unit}"


class MarkingTemplate(models.Model):
    template_name = models.CharField("Назва шаблону маркування", max_length=150)
    client = models.ForeignKey(Client, on_delete=models.CASCADE, verbose_name="Клієнт")
    product = models.ForeignKey(Nomenclature, on_delete=models.CASCADE, verbose_name="Продукція")
    text = models.TextField("Текст маркування")

    class Meta:
        verbose_name = "Шаблон маркування"
        verbose_name_plural = "Шаблони маркування"

    def __str__(self):
        return self.template_name


class WorkCenter(models.Model):
    code = models.CharField("Код лінії / Обладнання", max_length=50, unique=True)
    name = models.CharField("Назва лінії", max_length=255)
    is_active = models.BooleanField("Активна", default=True)

    class Meta:
        verbose_name = "Виробнича лінія"
        verbose_name_plural = "Виробничі лінії"

    def __str__(self):
        return f"{self.name} ({self.code})"


class ProductRouting(models.Model):
    product = models.ForeignKey(Nomenclature, on_delete=models.CASCADE, verbose_name="Продукт / Напівфабрикат")
    work_center = models.ForeignKey(WorkCenter, on_delete=models.CASCADE, verbose_name="Виробнича лінія")
    speed_m_per_min = models.FloatField("Швидкість лінії (м/хв)", default=0.0)
    is_primary = models.BooleanField("Основний маршрут", default=True)
    ketr = models.CharField("КЕТР", max_length=100, blank=True, help_text="Карта етапного технологічного режиму (комбінація Лінія - Продукт)")

    class Meta:
        verbose_name = "Технологічний маршрут"
        verbose_name_plural = "Технологічні маршрути"

    def __str__(self):
        return f"{self.product.name} @ {self.work_center.code}"


class Order(models.Model):
    ORDER_STATUS_CHOICES = [
        ('new', 'Новий'),
        ('in_work', 'В роботі'),
        ('done', 'Готовий'),
    ]
    FIBER_TYPE_CHOICES = [
        ('G.652.D', 'G.652.D (Стандартний одномод)'),
        ('G.657.A1', 'G.657.A1 (Зменшені втрати на згинах)'),
        ('G.657.A2', 'G.657.A2 (Мінімальний радіус згину)'),
        ('G.655', 'G.655 (Незсунена дисперсія)'),
        ('OM1', 'OM1 (Багатомод 62.5/125)'),
        ('OM2', 'OM2 (Багатомод 50/125)'),
        ('OM3', 'OM3 (Багатомод 50/125 LO)'),
        ('OM4', 'OM4 (Багатомод високошвидкісний)'),
        ('Без ОВ', 'Без оптичного волокна (Елементи захисту/Дріт)'),
    ]
    order_number = models.CharField("Номер замовлення", max_length=100, unique=True)
    client = models.ForeignKey(Client, on_delete=models.CASCADE, verbose_name="Клієнт")
    product = models.ForeignKey(Nomenclature, on_delete=models.CASCADE, verbose_name="Кабель")
    fiber_type = models.CharField("Тип волокна", max_length=50, choices=FIBER_TYPE_CHOICES, blank=True, help_text="Обов'язковий вибір марки ОВ")
    quantity = models.FloatField("Кількість в замовленні (км)")
    length_per_drum = models.FloatField("Довжина на тарі (км)", blank=True, null=True, help_text="Будівельна довжина кабелю на одному барабані")
    status = models.CharField("Статус", max_length=20, choices=ORDER_STATUS_CHOICES, default='new')
    deadline = models.DateField("Термін виконання")

    class Meta:
        verbose_name = "Замовлення"
        verbose_name_plural = "Замовлення"

    def __str__(self):
        return f"Зам №{self.order_number} ({self.client.name}) - {self.fiber_type}"


class ProductionPlan(models.Model):
    PLAN_STATUS_CHOICES = [
        ('queued', 'В черзі'),
        ('in_progress', 'Частково виконано'),  # Змінено з 'Виконується' для відповідності логіці
        ('completed', 'Завершено'),
    ]
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name='plans', verbose_name="Замовлення")
    product = models.ForeignKey(Nomenclature, on_delete=models.CASCADE, verbose_name="Що виготовляємо")
    fiber_type = models.CharField("Тип волокна", max_length=50, blank=True, help_text="Наслідується із замовлення автоматично")
    quantity_needed = models.FloatField("Необхідна кількість (км)")
    work_center = models.ForeignKey(WorkCenter, on_delete=models.PROTECT, verbose_name="Виробнича лінія", blank=True, null=True)
    duration_hours = models.FloatField("Розрахунковий час работы лінії (годин)", default=0.0)
    planned_start = models.DateTimeField("Плановий час початку", blank=True, null=True)
    planned_end = models.DateTimeField("Плановий час завершення", blank=True, null=True)
    stage_name = models.CharField("Технологічний етап", max_length=150, blank=True)
    status = models.CharField("Статус етапу", max_length=20, choices=PLAN_STATUS_CHOICES, default='queued')

    class Meta:
        verbose_name = "Директивний план"
        verbose_name_plural = "Директивний план"

    def __str__(self):
        return f"План: {self.order.order_number} ➔ {self.product.name} ({self.quantity_needed} км)"

    def save(self, *args, **kwargs):
        if self.order and not self.fiber_type:
            self.fiber_type = self.order.fiber_type
        super().save(*args, **kwargs)

    @property
    def actual_quantity(self):
        total = self.productionlog_set.aggregate(total_km=Sum('quantity_produced'))['total_km']
        return total if total else 0.0

    @property
    def planned_reduced_6(self):
        if self.product.fiber_count and self.product.fiber_count > 0:
            return self.quantity_needed * (self.product.fiber_count / 6.0)
        return 0.0

    @property
    def actual_reduced_6(self):
        if self.product.fiber_count and self.product.fiber_count > 0:
            return self.actual_quantity * (self.product.fiber_count / 6.0)
        return 0.0


class Employee(models.Model):
    first_name = models.CharField("Ім'я", max_length=100)
    last_name = models.CharField("Прізвище", max_length=100)
    position = models.CharField("Посада", max_length=150)
    is_active = models.BooleanField("Працює", default=True)

    class Meta:
        verbose_name = "Співробітник"
        verbose_name_plural = "Співробітники"

    def __str__(self):
        return f"{self.last_name} {self.first_name}"


class ProductionLog(models.Model):
    production_plan = models.ForeignKey(ProductionPlan, null=True, blank=True, on_delete=models.SET_NULL, verbose_name="Завдання з плану")
    quantity_produced = models.FloatField("Фактично виготовлено (км/шт)", default=0.0)
    date_created = models.DateTimeField(auto_now_add=True, verbose_name="Дата запису")
    production_type = models.CharField("Тип роботи", max_length=50, default="Серійна")
    operator = models.ForeignKey(Employee, on_delete=models.PROTECT, verbose_name="Оператор лінії")
    has_deviation = models.BooleanField("Є відхилення", default=False)
    deviation_comment = models.TextField("Коментар до відхилення", blank=True)
    has_downtime = models.BooleanField("Був простій", default=False)
    downtime_hours = models.IntegerField("Простій (годин)", default=0, blank=True)
    downtime_minutes = models.IntegerField("Простій (хвилин)", default=0, blank=True)
    downtime_reason = models.TextField("Причина простою", blank=True)

    class Meta:
        verbose_name = "Виконане завдання (Журнал)"
        verbose_name_plural = "Журнал виконаних завдань"

    def __str__(self):
        return f"Звіт від {self.date_created.strftime('%d.%m.%Y')} - {self.operator}"


# === ВІДНОВЛЕНИЙ МЕХАНІЗМ ГЕНЕРАЦІЇ ПІДЗАМОВЛЕНЬ (РОЗГОРТАННЯ ДЕРЕВА BOM) ===
@receiver(post_save, sender=Order)
def create_production_plan_from_order(sender, instance, created, **kwargs):
    """
    При збереженні замовлення рекурсивно розгортає його специфікацію,
    знаходячи всі напівфабрикати, та створює підзамовлення для ліній в Директивному плані.
    """
    # Очищаємо старі чернетки планів для цього замовлення, щоб не було дублів при оновленні довжини чи ОВ
    ProductionPlan.objects.filter(order=instance, status='queued').delete()

    def unwind_nomenclature(nomenclature, current_quantity):
        # 1. Створюємо позицію плану для поточної номенклатури (кабелю або модуля)
        routes = ProductRouting.objects.filter(product=nomenclature, is_primary=True)
        
        if routes.exists():
            for route in routes:
                duration = 0.0
                if route.speed_m_per_min > 0:
                    # Розрахунок часу: (кілометри * 1000) / швидкість в хв / 60 хвилин
                    duration = (current_quantity * 1000.0) / route.speed_m_per_min / 60.0
                
                ProductionPlan.objects.create(
                    order=instance,
                    product=nomenclature,
                    fiber_type=instance.fiber_type,
                    quantity_needed=round(current_quantity, 3),
                    work_center=route.work_center,
                    stage_name=route.ketr or f"Виробництво {nomenclature.name} на {route.work_center.code}",
                    duration_hours=round(duration, 2),
                    status='queued'
                )
        else:
            # Дефолтний етап, якщо маршрут ще не заведено технологами
            ProductionPlan.objects.create(
                order=instance,
                product=nomenclature,
                fiber_type=instance.fiber_type,
                quantity_needed=round(current_quantity, 3),
                stage_name=f"Етап: {nomenclature.name} (маршрут не задано)",
                status='queued'
            )

        # 2. Рекурсивно спускаємось у специфікацію номенклатури у пошуках напівфабрикатів (підзамовлень)
        specs = Specification.objects.filter(product=nomenclature)
        for spec in specs:
            if spec.ingredient.item_type in ['half_product', 'product']:
                # Обчислюємо необхідну довжину підзамовлення на основі норми витрати матеріалу
                sub_quantity = current_quantity * spec.quantity
                unwind_nomenclature(spec.ingredient, sub_quantity)

    # Запускаємо розгортання дерева з головного продукту замовлення
    unwind_nomenclature(instance.product, instance.quantity)


# === АВТОМАТИЧНА ЗМІНА СТАТУСУ ДИРЕКТИВНОГО ПЛАНУ НА ОСНОВІ ЛОГІВ ===
@receiver(post_save, sender=ProductionLog)
@receiver(post_delete, sender=ProductionLog)
def update_production_plan_status(sender, instance, **kwargs):
    """
    При додаванні, зміні або видаленні запису в Журналі,
    система автоматично перераховує фактичну кількість
    і змінює статус відповідного завдання в плані.
    """
    plan = instance.production_plan
    if not plan:
        return

    # Сумуємо всі фактичні випуски для цього конкретного плану
    total_produced = plan.productionlog_set.aggregate(total=Sum('quantity_produced'))['total'] or 0.0

    # Округлюємо до 3 знаків після коми для точності порівняння
    total_produced_rounded = round(total_produced, 3)
    needed_rounded = round(plan.quantity_needed, 3)

    # Логіка визначення статусу
    if total_produced_rounded <= 0:
        new_status = 'queued'        # В черзі
    elif total_produced_rounded >= needed_rounded:
        new_status = 'completed'     # Завершено
    else:
        new_status = 'in_progress'   # Частково виконано

    # Зберігаємо новий статус, якщо він змінився
    if plan.status != new_status:
        plan.status = new_status
        plan.save(update_fields=['status'])