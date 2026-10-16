from django.apps import AppConfig

class WarehouseConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'warehouse'
    # Оновлена назва для відображення всього блоку в адмінці
    verbose_name = 'Панель управління виробництвом'