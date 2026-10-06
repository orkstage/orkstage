param location string = resourceGroup().location

resource cache 'Microsoft.Cache/redis@2024-03-01' = {
  name: 'shop-cache'
  location: location
  properties: { sku: { name: 'Basic', family: 'C', capacity: 0 } }
}

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'shop-pg'
  location: location
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: 'shop'
}

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: 'shop-legacy'
  location: location
}
