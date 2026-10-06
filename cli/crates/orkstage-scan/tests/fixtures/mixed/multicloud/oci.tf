resource "oci_objectstorage_bucket" "files" {
  name       = "files"
  namespace  = "acme"
  versioning = "Enabled"
}
