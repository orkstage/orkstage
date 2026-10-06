resource "azurerm_postgresql_flexible_server" "data" {
  name       = "data"
  version    = "17"
  sku_name   = "GP_Standard_D2ds_v5"
  storage_mb = 51200
  high_availability {
    mode = "ZoneRedundant"
  }
}
