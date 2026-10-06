resource "azurerm_resource_group" "rg" {
  name     = "shop"
  location = "westeurope"
}

resource "azurerm_postgresql_flexible_server" "db" {
  name                  = "shop-db"
  resource_group_name   = azurerm_resource_group.rg.name
  location              = azurerm_resource_group.rg.location
  version               = "16"
  sku_name              = "GP_Standard_D2s_v3"
  storage_mb            = 65536
  backup_retention_days = 14
  high_availability {
    mode = "ZoneRedundant"
  }
}

resource "azurerm_storage_account" "files" {
  name                     = "shopfiles"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "ZRS"
  blob_properties {
    versioning_enabled = true
  }
}

resource "azurerm_container_app" "web" {
  name                         = "shop-web"
  resource_group_name          = azurerm_resource_group.rg.name
  container_app_environment_id = "env-id"
  revision_mode                = "Single"
  template {
    min_replicas = 2
    container {
      name   = "web"
      image  = "shopacr.azurecr.io/web:3.0"
      cpu    = 0.5
      memory = "1Gi"
    }
  }
  ingress {
    external_enabled = true
    target_port      = 8000
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

resource "azurerm_mysql_flexible_server" "legacy" {
  name = "legacy"
}
