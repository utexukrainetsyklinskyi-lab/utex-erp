from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from warehouse import workspace

urlpatterns = [
    path('', workspace.dashboard, name='dashboard'),
    # Адмін-панель Django
    path('admin/', admin.site.urls),
    
    # Підключаємо всі маршрути з нашого додатка warehouse
    path('warehouse/', include('warehouse.urls')),
]

# Дозволяємо Django самостійно роздавати медіа-файли під час розробки
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
