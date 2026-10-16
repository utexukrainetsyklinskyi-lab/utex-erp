"""Desktop production UI backed by the existing ERP models."""
from functools import wraps

from django.contrib import messages
from django.contrib.admin.views.decorators import staff_member_required
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db import transaction
from django.db.models import Count, F, Q, Sum
from django.db.models.functions import Coalesce
from django.http import Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from .models import Order, ProductionLog, ProductionPlan, WorkCenter, ProductRouting
from .workspace_forms import DIRECTORIES, ExecutionForm, OrderForm, StageForm, directory_form


def access(*permissions):
    """Reuse staff access and Django model permissions; do not introduce new roles."""
    def decorate(view):
        @staff_member_required
        @wraps(view)
        def wrapped(request, *args, **kwargs):
            if not request.user.has_perms(permissions):
                raise PermissionDenied
            return view(request, *args, **kwargs)
        return wrapped
    return decorate


def context(section, title, **extra):
    return {"section": section, "title": title, "today": timezone.localdate(), **extra}


def plans():
    return ProductionPlan.objects.select_related("order__client", "product", "work_center").annotate(
        produced=Coalesce(Sum("productionlog__quantity_produced"), 0.0)
    ).order_by(F("planned_start").asc(nulls_last=True), "id")


def decorate_plans(items):
    today = timezone.localdate()
    for plan in items:
        plan.progress = max(0, min(100, round(plan.produced / plan.quantity_needed * 100))) if plan.quantity_needed > 0 else 0
        plan.remaining = max(0, plan.quantity_needed - plan.produced)
        plan.overdue = plan.status != "completed" and plan.order.deadline < today
    return items


def page_context(request, queryset):
    page = Paginator(queryset, 20).get_page(request.GET.get("page"))
    params = request.GET.copy()
    params.pop("page", None)
    return {"page": page, "querystring": params.urlencode()}


@access("warehouse.view_productionplan", "warehouse.view_order", "warehouse.view_workcenter", "warehouse.view_productionlog")
def dashboard(request):
    today = timezone.localdate()
    active = plans().exclude(status="completed")
    centers = WorkCenter.objects.filter(is_active=True).annotate(
        open_count=Count("productionplan", filter=~Q(productionplan__status="completed")),
        remaining_hours=Coalesce(Sum("productionplan__duration_hours", filter=~Q(productionplan__status="completed")), 0.0),
    ).order_by("code")
    logs = ProductionLog.objects.select_related("operator", "production_plan__product", "production_plan__order").order_by("-date_created")
    return render(request, "workspace/dashboard.html", context(
        "dashboard", "Огляд виробництва",
        active_count=active.count(), progress_count=active.filter(status="in_progress").count(),
        overdue_count=Order.objects.exclude(status="done").filter(deadline__lt=today).count(),
        today_logs=logs.filter(date_created__date=today).count(),
        unscheduled_count=active.filter(Q(planned_start__isnull=True) | Q(planned_end__isnull=True)).count(),
        focus_plans=decorate_plans(list(active.order_by("order__deadline", "id")[:6])),
        centers=centers, recent_logs=logs[:4],
    ))


@access("warehouse.view_productionplan")
def plan_list(request):
    queryset = plans()
    q = request.GET.get("q", "").strip()
    status = request.GET.get("status", "active")
    center = request.GET.get("center", "")
    if q:
        queryset = queryset.filter(Q(order__order_number__icontains=q) | Q(product__name__icontains=q) | Q(stage_name__icontains=q))
    if status == "active":
        queryset = queryset.exclude(status="completed")
    elif status in dict(ProductionPlan.PLAN_STATUS_CHOICES):
        queryset = queryset.filter(status=status)
    if center.isdigit():
        queryset = queryset.filter(work_center_id=center)
    if request.GET.get("unscheduled") == "1":
        queryset = queryset.filter(Q(planned_start__isnull=True) | Q(planned_end__isnull=True))
    data = page_context(request, queryset)
    decorate_plans(data["page"].object_list)
    return render(request, "workspace/plans.html", context(
        "plans", "Виробничий план", q=q, status=status, center=center,
        centers=WorkCenter.objects.order_by("code"), statuses=ProductionPlan.PLAN_STATUS_CHOICES, **data,
    ))


@access("warehouse.view_productionplan")
def plan_detail(request, pk):
    plan = get_object_or_404(plans(), pk=pk)
    decorate_plans([plan])
    logs = plan.productionlog_set.select_related("operator").order_by("-date_created") if request.user.has_perm("warehouse.view_productionlog") else []
    routes = ProductRouting.objects.filter(product=plan.product, work_center__is_active=True).select_related("work_center")
    return render(request, "workspace/plan_detail.html", context(
        "plans", f"Завдання №{plan.pk}", plan=plan, logs=logs, routes=routes,
    ))


@access("warehouse.add_productionlog")
@require_http_methods(["GET", "POST"])
def execution_create(request, pk=None):
    plan = get_object_or_404(plans(), pk=pk) if pk else None
    form = ExecutionForm(request.POST if request.method == "POST" else None, plan=plan)
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            # Serialize concurrent reports for the same plan on databases supporting row locks.
            ProductionPlan.objects.select_for_update().get(pk=form.cleaned_data["production_plan"].pk)
            entry = form.save()
        messages.success(request, "Виконання записано. Прогрес завдання оновлено.")
        return redirect("warehouse:plan_detail", pk=entry.production_plan_id)
    return render(request, "workspace/form.html", context(
        "logs", "Записати виконання", form=form,
        description=f"Завдання №{plan.pk} · {plan.product.name}" if plan else "Зафіксуйте новий випуск, простій або відхилення.",
        cancel_url=reverse("warehouse:plan_detail", args=[plan.pk]) if plan else reverse("warehouse:log_list"),
        form_kind="execution",
    ))


@access("warehouse.add_productionplan")
@require_http_methods(["GET", "POST"])
def stage_create(request):
    initial = {}
    if request.GET.get("order", "").isdigit():
        initial["order"] = get_object_or_404(Order, pk=request.GET["order"])
    form = StageForm(request.POST if request.method == "POST" else None, initial=initial)
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            plan = form.save()
        messages.success(request, "Виробничий етап додано. Час початку можна задати в картці завдання.")
        return redirect("warehouse:plan_detail", pk=plan.pk)
    return render(request, "workspace/form.html", context(
        "plans", "Новий виробничий етап", form=form,
        description="Додаткове завдання для замовлення. Звичайні етапи створюються автоматично зі специфікації.",
        cancel_url=reverse("warehouse:plan_list"),
    ))


@access("warehouse.view_order")
def order_list(request):
    queryset = Order.objects.select_related("client", "product").annotate(
        total_stages=Count("plans"), done_stages=Count("plans", filter=Q(plans__status="completed"))
    ).order_by("deadline", "-id")
    q, status = request.GET.get("q", "").strip(), request.GET.get("status", "")
    if q:
        queryset = queryset.filter(Q(order_number__icontains=q) | Q(client__name__icontains=q) | Q(product__name__icontains=q))
    if status in dict(Order.ORDER_STATUS_CHOICES):
        queryset = queryset.filter(status=status)
    if request.GET.get("overdue") == "1":
        queryset = queryset.exclude(status="done").filter(deadline__lt=timezone.localdate())
    return render(request, "workspace/orders.html", context(
        "orders", "Замовлення", q=q, status=status, statuses=Order.ORDER_STATUS_CHOICES, **page_context(request, queryset),
    ))


@access("warehouse.view_order")
def order_detail(request, pk):
    order = get_object_or_404(Order.objects.select_related("client", "product"), pk=pk)
    order_plans = decorate_plans(list(plans().filter(order=order))) if request.user.has_perm("warehouse.view_productionplan") else []
    return render(request, "workspace/order_detail.html", context(
        "orders", f"Замовлення {order.order_number}", order=order, order_plans=order_plans,
    ))


@access("warehouse.add_order")
@require_http_methods(["GET", "POST"])
def order_create(request):
    form = OrderForm(request.POST if request.method == "POST" else None)
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            order = form.save()
        messages.success(request, "Замовлення створено. Виробничі етапи сформовано за специфікацією.")
        return redirect("warehouse:order_detail", pk=order.pk)
    return render(request, "workspace/form.html", context(
        "orders", "Нове замовлення", form=form,
        description="Вкажіть клієнта, продукцію та термін. Виробничий план сформується автоматично.",
        cancel_url=reverse("warehouse:order_list"),
    ))


@access("warehouse.view_productionlog")
def log_list(request):
    queryset = ProductionLog.objects.select_related("operator", "production_plan__order", "production_plan__product").order_by("-date_created")
    q = request.GET.get("q", "").strip()
    if q:
        queryset = queryset.filter(Q(operator__last_name__icontains=q) | Q(production_plan__order__order_number__icontains=q) | Q(production_plan__product__name__icontains=q))
    kind = request.GET.get("kind", "")
    if kind == "downtime":
        queryset = queryset.filter(has_downtime=True)
    elif kind == "deviation":
        queryset = queryset.filter(has_deviation=True)
    return render(request, "workspace/logs.html", context(
        "logs", "Журнал виконання", q=q, kind=kind, **page_context(request, queryset),
    ))


@access()
def directories(request):
    items = []
    for key, (model, title, description, fields, search) in DIRECTORIES.items():
        if request.user.has_perm(f"warehouse.view_{model._meta.model_name}"):
            items.append({"key": key, "title": title, "description": description, "count": model.objects.count()})
    return render(request, "workspace/directories.html", context("directories", "Довідники", items=items))


def directory_config(request, key, action):
    if key not in DIRECTORIES:
        raise Http404
    config = DIRECTORIES[key]
    if not request.user.has_perm(f"warehouse.{action}_{config[0]._meta.model_name}"):
        raise PermissionDenied
    return config


@access()
def directory_list(request, key):
    model, title, description, fields, search = directory_config(request, key, "view")
    queryset = model.objects.all().order_by("-pk")
    for name in fields:
        if model._meta.get_field(name).many_to_one:
            queryset = queryset.select_related(name)
    q = request.GET.get("q", "").strip()
    if q:
        condition = Q()
        for field in search:
            condition |= Q(**{f"{field}__icontains": q})
        queryset = queryset.filter(condition)
    data = page_context(request, queryset)
    rows = []
    for obj in data["page"]:
        cells = []
        for name in fields:
            value = getattr(obj, f"get_{name}_display")() if hasattr(obj, f"get_{name}_display") else getattr(obj, name)
            if isinstance(value, bool):
                value = "Так" if value else "Ні"
            cells.append(value if value != "" else "—")
        rows.append({"pk": obj.pk, "cells": cells})
    return render(request, "workspace/directory_list.html", context(
        "directories", title, description=description, key=key, q=q,
        headers=[model._meta.get_field(name).verbose_name for name in fields], rows=rows,
        can_add=request.user.has_perm(f"warehouse.add_{model._meta.model_name}"),
        can_change=request.user.has_perm(f"warehouse.change_{model._meta.model_name}"), **data,
    ))


@access()
@require_http_methods(["GET", "POST"])
def directory_edit(request, key, pk=None):
    model, title, description, fields, search = directory_config(request, key, "change" if pk else "add")
    instance = get_object_or_404(model, pk=pk) if pk else None
    form = directory_form(model, fields)(request.POST if request.method == "POST" else None, instance=instance)
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            form.save()
        messages.success(request, "Зміни збережено.")
        return redirect("warehouse:directory_list", key=key)
    return render(request, "workspace/form.html", context(
        "directories", ("Редагування · " if pk else "Додати · ") + title,
        form=form, description=description, cancel_url=reverse("warehouse:directory_list", args=[key]),
    ))
