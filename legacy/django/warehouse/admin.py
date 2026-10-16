from django import forms
from django.contrib import admin
from django.utils.html import format_html
from django.utils.safestring import mark_safe
from django.urls import reverse
from .models import (
    Client, Nomenclature, Specification, MarkingTemplate, 
    WorkCenter, ProductRouting, Order, ProductionPlan, 
    Employee, ProductionLog
)

class SpecificationInline(admin.TabularInline):
    model = Specification
    fk_name = 'product'
    extra = 1
    verbose_name = "Компонент специфікації"
    verbose_name_plural = "Склад构造ції (Специфікація)"


@admin.register(Nomenclature)
class NomenclatureAdmin(admin.ModelAdmin):
    list_display = ('sku', 'name', 'structure_sku', 'fiber_count', 'item_type', 'unit')
    list_filter = ('item_type', 'unit')
    search_fields = ('sku', 'name', 'structure_sku')
    inlines = [SpecificationInline]


@admin.register(Client)
class ClientAdmin(admin.ModelAdmin):
    list_display = ('name', 'phone', 'email')
    search_fields = ('name', 'phone')


@admin.register(MarkingTemplate)
class MarkingTemplateAdmin(admin.ModelAdmin):
    list_display = ('template_name', 'client', 'product')
    list_filter = ('client',)
    search_fields = ('template_name', 'text')


@admin.register(WorkCenter)
class WorkCenterAdmin(admin.ModelAdmin):
    list_display = ('code', 'name', 'is_active')
    list_filter = ('is_active',)


@admin.register(ProductRouting)
class ProductRoutingAdmin(admin.ModelAdmin):
    list_display = ('product', 'work_center', 'speed_m_per_min', 'ketr', 'is_primary')
    list_filter = ('is_primary', 'work_center')
    search_fields = ('product__name', 'ketr')


@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ('order_number', 'client', 'product', 'fiber_type', 'quantity', 'length_per_drum', 'status', 'deadline')
    list_filter = ('status', 'client', 'fiber_type')
    search_fields = ('order_number', 'client__name', 'product__name', 'fiber_type')


@admin.register(ProductionPlan)
class ProductionPlanAdmin(admin.ModelAdmin):
    list_display = ('order', 'product', 'fiber_type', 'get_structure_sku', 'get_fiber_count', 'formatted_quantity', 'work_center', 'duration_hours', 'status', 'create_on_basis')
    list_filter = ('status', 'work_center', 'fiber_type', 'product__item_type')
    search_fields = ('order__order_number', 'product__name', 'fiber_type')

    def get_structure_sku(self, obj):
        return obj.product.structure_sku
    get_structure_sku.short_description = "Арт. Конструкції"

    def get_fiber_count(self, obj):
        return obj.product.fiber_count
    get_fiber_count.short_description = "К-ть ОВ"

    def formatted_quantity(self, obj):
        return f"{obj.quantity_needed:.3f} {obj.product.unit}"
    formatted_quantity.short_description = "Необхідно"
    formatted_quantity.admin_order_field = 'quantity_needed'

    def create_on_basis(self, obj):
        url = reverse('admin:warehouse_productionlog_add') + f"?production_plan={obj.id}&quantity_produced={obj.quantity_needed}"
        return format_html(
            '<a class="button" style="background-color: #264b5c; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold; text-decoration: none;" href="{}">➕ На підставі</a>', 
            url
        )
    create_on_basis.short_description = "Дія"

    # =========================================================================
    # ФІКС ПОМИЛКИ ContentNotRenderedError ПРИ СОРТУВАННІ ТА ФІЛЬТРАЦІЇ
    # =========================================================================
    def changelist_view(self, request, extra_context=None):
        response = super().changelist_view(request, extra_context=extra_context)
        
        # Примусово рендеримо сторінку перед поверненням, щоб уникнути конфліктів у ядрі Django
        if hasattr(response, 'render') and callable(response.render):
            response.render()
            
        return response


@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    list_display = ('last_name', 'first_name', 'position', 'is_active')
    list_filter = ('is_active', 'position')
    search_fields = ('last_name', 'first_name')


class ProductionLogForm(forms.ModelForm):
    class Meta:
        model = ProductionLog
        fields = '__all__'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        
        dynamic_js = """
        <script>
            document.addEventListener('DOMContentLoaded', function() {
                var hasDeviation = document.getElementById('id_has_deviation');
                var deviationRow = document.querySelector('.field-deviation_comment');
                
                var hasDowntime = document.getElementById('id_has_downtime');
                var downtimeRow = document.querySelector('.field-downtime_hours');
                var downtimeReasonRow = document.querySelector('.field-downtime_reason');

                function toggleDeviation() {
                    if (deviationRow) deviationRow.style.display = hasDeviation.checked ? '' : 'none';
                }
                function toggleDowntime() {
                    if (downtimeRow) downtimeRow.style.display = hasDowntime.checked ? '' : 'none';
                    if (downtimeReasonRow) downtimeReasonRow.style.display = hasDowntime.checked ? '' : 'none';
                }

                if (hasDeviation) { hasDeviation.addEventListener('change', toggleDeviation); toggleDeviation(); }
                if (hasDowntime) { hasDowntime.addEventListener('change', toggleDowntime); toggleDowntime(); }
            });
        </script>
        """
        self.fields['has_deviation'].help_text = mark_safe(dynamic_js)


@admin.register(ProductionLog)
class ProductionLogAdmin(admin.ModelAdmin):
    form = ProductionLogForm
    list_display = ('date_created', 'production_plan', 'quantity_produced', 'production_type', 'operator', 'has_deviation', 'has_downtime')
    list_filter = ('production_type', 'has_deviation', 'has_downtime', 'operator')
    search_fields = ('operator__last_name', 'deviation_comment')
    
    fieldsets = (
        ("Основна інформація", {
            'fields': ('production_plan', 'quantity_produced', 'production_type', 'operator')
        }),
        ("Якість та Відхилення", {
            'fields': ('has_deviation', 'deviation_comment')
        }),
        ("Облік Простоїв", {
            'fields': ('has_downtime', ('downtime_hours', 'downtime_minutes'), 'downtime_reason')
        }),
    )