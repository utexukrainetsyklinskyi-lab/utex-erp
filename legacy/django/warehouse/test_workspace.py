from datetime import timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import Client, Employee, Nomenclature, Order, ProductRouting, ProductionLog, ProductionPlan, Specification, WorkCenter


class ProductionWorkspaceTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_superuser("tester", password="test-password")
        cls.customer = Client.objects.create(name="Тестовий клієнт")
        cls.product = Nomenclature.objects.create(sku="TEST-001", name="Тестовий кабель", item_type="product")
        cls.center = WorkCenter.objects.create(code="SCL", name="Тестова лінія")
        cls.route = ProductRouting.objects.create(product=cls.product, work_center=cls.center, speed_m_per_min=100)
        cls.operator = Employee.objects.create(first_name="Тест", last_name="Оператор", position="Оператор")
        cls.order = Order.objects.create(order_number="TEST-ORDER", client=cls.customer, product=cls.product,
                                        quantity=10, fiber_type="G.652.D", deadline=timezone.localdate() + timedelta(days=7))
        cls.plan = cls.order.plans.get()

    def setUp(self):
        self.client.force_login(self.user)

    def test_all_workspace_pages_render(self):
        paths = ["/", "/warehouse/plans/", f"/warehouse/plans/{self.plan.pk}/",
                 "/warehouse/plans/new/", f"/warehouse/plans/{self.plan.pk}/execution/",
                 "/warehouse/orders/", "/warehouse/orders/new/", f"/warehouse/orders/{self.order.pk}/",
                 "/warehouse/logs/", "/warehouse/logs/new/", "/warehouse/directories/", "/warehouse/monitor/"]
        for key in ["clients", "products", "routes", "centers", "employees", "markings"]:
            paths.extend([f"/warehouse/directories/{key}/", f"/warehouse/directories/{key}/new/"])
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

    def test_anonymous_redirects_to_existing_login(self):
        self.client.logout()
        for path in ["/", "/warehouse/plans/", "/warehouse/logs/new/", "/warehouse/monitor/"]:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 302)
            self.assertTrue(response.url.startswith("/admin/login/"))

    def test_staff_without_model_permissions_cannot_write(self):
        staff = get_user_model().objects.create_user("limited", is_staff=True)
        self.client.force_login(staff)
        for path in ["/warehouse/logs/new/", "/warehouse/orders/new/", "/warehouse/plans/new/", "/warehouse/directories/clients/new/"]:
            self.assertEqual(self.client.post(path, {}).status_code, 403)
        self.assertEqual(ProductionLog.objects.count(), 0)

    def test_view_only_permission_does_not_allow_add(self):
        staff = get_user_model().objects.create_user("viewer", is_staff=True)
        staff.user_permissions.add(Permission.objects.get(codename="view_productionplan"))
        self.client.force_login(staff)
        self.assertEqual(self.client.get("/warehouse/plans/").status_code, 200)
        self.assertEqual(self.client.post("/warehouse/plans/new/", {}).status_code, 403)

    def execution_data(self, **changes):
        data = {"production_plan": self.plan.pk, "operator": self.operator.pk, "quantity_produced": 4,
                "production_type": "Серійна", "downtime_hours": "", "downtime_minutes": ""}
        data.update(changes)
        return data

    def test_execution_updates_progress_and_status(self):
        response = self.client.post(reverse("warehouse:plan_execution", args=[self.plan.pk]), self.execution_data())
        self.assertEqual(response.status_code, 302)
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.status, "in_progress")
        self.assertEqual(self.plan.actual_quantity, 4)
        self.client.post(reverse("warehouse:plan_execution", args=[self.plan.pk]), self.execution_data(quantity_produced=6))
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.status, "completed")
        self.assertEqual(self.plan.actual_quantity, 10)

    def test_invalid_execution_never_writes(self):
        for changes in [{"quantity_produced": -1}, {"quantity_produced": "nan"}, {"quantity_produced": 0},
                        {"has_downtime": "on", "downtime_hours": 1, "downtime_minutes": 70},
                        {"has_deviation": "on", "deviation_comment": ""}]:
            with self.subTest(changes=changes):
                response = self.client.post("/warehouse/logs/new/", self.execution_data(**changes))
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.context["form"].errors)
        self.assertEqual(ProductionLog.objects.count(), 0)

    def test_downtime_only_report(self):
        response = self.client.post("/warehouse/logs/new/", self.execution_data(
            quantity_produced=0, has_downtime="on", downtime_hours=1, downtime_minutes=15, downtime_reason="Налаштування"))
        self.assertEqual(response.status_code, 302)
        entry = ProductionLog.objects.get()
        self.assertEqual(entry.downtime_hours, 1)
        self.assertEqual(entry.downtime_minutes, 15)
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.status, "queued")

    def test_bound_execution_cannot_target_other_plan(self):
        other = ProductionPlan.objects.create(order=self.order, product=self.product, quantity_needed=5)
        self.client.post(reverse("warehouse:plan_execution", args=[self.plan.pk]),
                         self.execution_data(production_plan=other.pk))
        self.assertEqual(ProductionLog.objects.get().production_plan_id, self.plan.pk)

    def test_create_order_preserves_bom_generation(self):
        part = Nomenclature.objects.create(sku="PART", name="Модуль", item_type="half_product")
        Specification.objects.create(product=self.product, ingredient=part, quantity=2)
        response = self.client.post("/warehouse/orders/new/", {
            "order_number": "NEW", "client": self.customer.pk, "product": self.product.pk,
            "fiber_type": "G.652.D", "quantity": 5, "length_per_drum": 1,
            "deadline": (timezone.localdate() + timedelta(days=2)).isoformat(),
        })
        self.assertEqual(response.status_code, 302)
        order = Order.objects.get(order_number="NEW")
        self.assertEqual(order.plans.count(), 2)
        self.assertEqual(order.plans.get(product=part).quantity_needed, 10)
        self.assertEqual(self.order.plans.count(), 1)

    def test_cyclic_bom_rejected_without_partial_order(self):
        Specification.objects.create(product=self.product, ingredient=self.product, quantity=1)
        response = self.client.post("/warehouse/orders/new/", {
            "order_number": "CYCLE", "client": self.customer.pk, "product": self.product.pk,
            "quantity": 1, "deadline": timezone.localdate().isoformat(),
        })
        self.assertEqual(response.status_code, 200)
        self.assertIn("product", response.context["form"].errors)
        self.assertFalse(Order.objects.filter(order_number="CYCLE").exists())

    def test_filters_and_empty_results(self):
        response = self.client.get("/warehouse/plans/?q=NONEXISTENT&status=all")
        self.assertEqual(response.context["page"].paginator.count, 0)
        response = self.client.get(f"/warehouse/plans/?center={self.center.pk}&q=TEST-ORDER")
        self.assertEqual(response.context["page"].paginator.count, 1)
        self.assertEqual(self.client.get("/warehouse/plans/?page=bad&center=bad").status_code, 200)

    def test_unknown_directory_is_404(self):
        self.assertEqual(self.client.get("/warehouse/directories/auth_user/").status_code, 404)

    def test_add_stage_validates_route(self):
        other_center = WorkCenter.objects.create(code="OTHER", name="Інша лінія")
        data = {"order": self.order.pk, "product": self.product.pk, "quantity_needed": 2, "stage_name": "Додатковий етап", "work_center": other_center.pk}
        response = self.client.post("/warehouse/plans/new/", data)
        self.assertIn("work_center", response.context["form"].errors)
        data["work_center"] = self.center.pk
        response = self.client.post("/warehouse/plans/new/", data)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.order.plans.count(), 2)

    def test_schedule_uses_kyiv_time_and_server_duration(self):
        response = self.client.post("/warehouse/api/gantt/update/", {
            "id": self.plan.pk, "group": self.center.pk, "start": "2026-10-01T09:00",
        }, content_type="application/json")
        self.assertEqual(response.json()["status"], "success")
        self.plan.refresh_from_db()
        self.assertEqual(timezone.localtime(self.plan.planned_start).hour, 9)
        self.assertEqual(self.plan.planned_end - self.plan.planned_start, timedelta(minutes=100))
        self.assertContains(self.client.get(reverse('warehouse:plan_detail', args=[self.plan.pk])),
                            'value="2026-10-01T09:00"')

    def test_schedule_dependency_without_route_reports_validation_message(self):
        part = Nomenclature.objects.create(sku="PART", name="Модуль", item_type="half_product")
        Specification.objects.create(product=self.product, ingredient=part, quantity=1)
        start = timezone.now()
        ProductionPlan.objects.create(order=self.order, product=part, quantity_needed=10,
                                      planned_start=start, planned_end=start + timedelta(hours=2))
        response = self.client.post("/warehouse/api/gantt/update/", {
            "id": self.plan.pk, "group": self.center.pk, "start": start.isoformat(),
        }, content_type="application/json")
        self.assertEqual(response.json()["status"], "error")
        self.assertIn("Порушення послідовності", response.json()["message"])
        self.plan.refresh_from_db()
        self.assertIsNone(self.plan.planned_start)

    def test_gantt_escapes_product_names(self):
        self.product.name = '<img src=x onerror=alert(1)>'
        self.product.save()
        self.plan.planned_start = timezone.now()
        self.plan.planned_end = timezone.now() + timedelta(hours=1)
        self.plan.save()
        response = self.client.get("/warehouse/api/gantt/data/")
        self.assertNotIn("<img", response.json()["items"][0]["content"])
        self.assertIn("&lt;img", response.json()["items"][0]["content"])
