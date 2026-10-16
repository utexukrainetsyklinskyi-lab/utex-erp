from django.urls import path
from . import views
from . import workspace

app_name = 'warehouse'

urlpatterns = [
    path('plans/', workspace.plan_list, name='plan_list'),
    path('plans/new/', workspace.stage_create, name='stage_create'),
    path('plans/<int:pk>/', workspace.plan_detail, name='plan_detail'),
    path('plans/<int:pk>/execution/', workspace.execution_create, name='plan_execution'),
    path('orders/', workspace.order_list, name='order_list'),
    path('orders/new/', workspace.order_create, name='order_create'),
    path('orders/<int:pk>/', workspace.order_detail, name='order_detail'),
    path('logs/', workspace.log_list, name='log_list'),
    path('logs/new/', workspace.execution_create, name='execution_create'),
    path('directories/', workspace.directories, name='directories'),
    path('directories/<slug:key>/', workspace.directory_list, name='directory_list'),
    path('directories/<slug:key>/new/', workspace.directory_edit, name='directory_create'),
    path('directories/<slug:key>/<int:pk>/edit/', workspace.directory_edit, name='directory_edit'),
    # Сторінка монітора ліній
    path('monitor/', views.gantt_monitor_view, name='gantt_monitor'),
    
    # API ендпоінти для графіка Ганта
    path('api/gantt/data/', views.gantt_data_api, name='gantt_data_api'),
    path('api/gantt/update/', views.gantt_update_api, name='gantt_update_api'),
]
