"""Forms for the production workspace; existing model signals remain authoritative."""
import math

from django import forms

from .models import (
    Client, Employee, MarkingTemplate, Nomenclature, Order,
    ProductRouting, ProductionLog, ProductionPlan, Specification, WorkCenter,
)


class WorkspaceForm(forms.ModelForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            if isinstance(field.widget, forms.Textarea):
                field.widget.attrs["rows"] = 3
            if isinstance(field, forms.DateField) and not isinstance(field, forms.DateTimeField):
                field.widget = forms.DateInput(format="%Y-%m-%d", attrs={"type": "date"})
            if isinstance(field, (forms.FloatField, forms.IntegerField)):
                field.widget.attrs["min"] = "0"
            field.widget.attrs.setdefault("class", "control")

    def clean(self):
        data = super().clean()
        for name, value in list(data.items()):
            if isinstance(value, (float, int)) and not isinstance(value, bool):
                if not math.isfinite(value) or value < 0:
                    self.add_error(name, "Вкажіть невід’ємне скінченне число.")
        return data


class OrderForm(WorkspaceForm):
    class Meta:
        model = Order
        fields = ["order_number", "client", "product", "fiber_type", "quantity", "length_per_drum", "deadline"]

    def clean(self):
        data = super().clean()
        quantity = data.get("quantity")
        drum = data.get("length_per_drum")
        if quantity is not None and quantity <= 0:
            self.add_error("quantity", "Кількість має бути більшою за нуль.")
        if drum is not None and (drum <= 0 or (quantity and drum > quantity)):
            self.add_error("length_per_drum", "Довжина барабана має бути додатною і не перевищувати замовлення.")
        # Protect the existing recursive BOM signal from malformed cyclic specifications.
        product = data.get("product")
        if product:
            edges = {}
            for parent, child in Specification.objects.filter(
                ingredient__item_type__in=["product", "half_product"]
            ).values_list("product_id", "ingredient_id"):
                edges.setdefault(parent, []).append(child)
            visiting, visited = set(), set()
            stack = [(product.pk, False)]
            while stack:
                node, leaving = stack.pop()
                if leaving:
                    visiting.discard(node)
                    visited.add(node)
                    continue
                if node in visiting:
                    self.add_error("product", "Специфікація містить цикл. Виправте її перед створенням замовлення.")
                    break
                if node in visited:
                    continue
                visiting.add(node)
                stack.append((node, True))
                stack.extend((child, False) for child in edges.get(node, []))
        return data


class ExecutionForm(WorkspaceForm):
    class Meta:
        model = ProductionLog
        fields = ["production_plan", "operator", "quantity_produced", "production_type",
                  "has_deviation", "deviation_comment", "has_downtime",
                  "downtime_hours", "downtime_minutes", "downtime_reason"]

    def __init__(self, *args, plan=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["production_plan"].required = True
        self.fields["production_plan"].queryset = ProductionPlan.objects.select_related(
            "order__client", "product"
        ).order_by("-id")
        self.fields["operator"].queryset = Employee.objects.filter(is_active=True)
        if plan:
            self.fields["production_plan"].initial = plan
            self.fields["production_plan"].disabled = True
        self.fields["quantity_produced"].label = "Виготовлено за цей запис"
        self.fields["quantity_produced"].help_text = "Лише новий випуск, а не загальний підсумок завдання."
        self.fields["downtime_minutes"].widget.attrs["max"] = "59"

    def clean(self):
        data = super().clean()
        if data.get("has_deviation"):
            if not (data.get("deviation_comment") or "").strip():
                self.add_error("deviation_comment", "Опишіть відхилення.")
        else:
            data["deviation_comment"] = ""
        if data.get("has_downtime"):
            hours, minutes = data.get("downtime_hours") or 0, data.get("downtime_minutes") or 0
            if minutes > 59:
                self.add_error("downtime_minutes", "Вкажіть від 0 до 59 хвилин.")
            if hours * 60 + minutes <= 0:
                self.add_error("downtime_hours", "Вкажіть тривалість простою.")
            if not (data.get("downtime_reason") or "").strip():
                self.add_error("downtime_reason", "Вкажіть причину простою.")
            data["downtime_hours"], data["downtime_minutes"] = hours, minutes
        else:
            data.update(downtime_hours=0, downtime_minutes=0, downtime_reason="")
        if data.get("quantity_produced") == 0 and not data.get("has_downtime") and not data.get("has_deviation"):
            self.add_error("quantity_produced", "Вкажіть випуск або зафіксуйте простій / відхилення.")
        return data


class StageForm(WorkspaceForm):
    class Meta:
        model = ProductionPlan
        fields = ["order", "product", "stage_name", "quantity_needed", "work_center"]

    def clean(self):
        data = super().clean()
        if data.get("quantity_needed") is not None and data["quantity_needed"] <= 0:
            self.add_error("quantity_needed", "Кількість має бути більшою за нуль.")
        product, center = data.get("product"), data.get("work_center")
        if product and center:
            route = ProductRouting.objects.filter(product=product, work_center=center).first()
            if not route:
                self.add_error("work_center", "Спочатку додайте технологічний маршрут для цього продукту й лінії.")
            elif route.speed_m_per_min > 0 and data.get("quantity_needed"):
                self.instance.duration_hours = round(data["quantity_needed"] * 1000 / route.speed_m_per_min / 60, 2)
        return data


# A deliberately small registry: no arbitrary models or fields can be edited through URLs.
DIRECTORIES = {
    "clients": (Client, "Клієнти", "Контакти та замовники", ["name", "phone", "email"], ["name", "phone", "email"]),
    "products": (Nomenclature, "Номенклатура", "Продукція, напівфабрикати та матеріали",
                 ["sku", "name", "item_type", "unit", "structure_sku", "fiber_count"], ["sku", "name", "structure_sku"]),
    "routes": (ProductRouting, "Технологічні маршрути", "Продукт, виробнича лінія та швидкість",
               ["product", "work_center", "speed_m_per_min", "is_primary", "ketr"], ["product__name", "work_center__name", "ketr"]),
    "centers": (WorkCenter, "Виробничі лінії", "Обладнання вашого виробництва", ["code", "name", "is_active"], ["code", "name"]),
    "employees": (Employee, "Співробітники", "Оператори та команда", ["last_name", "first_name", "position", "is_active"],
                  ["last_name", "first_name", "position"]),
    "markings": (MarkingTemplate, "Маркування", "Шаблони маркування продукції", ["template_name", "client", "product", "text"],
                 ["template_name", "client__name", "product__name"]),
}


def directory_form(model, fields):
    return forms.modelform_factory(model, form=WorkspaceForm, fields=fields)
