# Reviewed VAY-965 prerequisite infrastructure and admitted setup callers.
# Keep these prerequisites enabled after activation; lifecycle guards retain live tasks.
enable_hotel_setup_private_network           = true
enable_hotel_setup_property_network          = true
enable_hotel_setup_credential_infrastructure = true
enable_hotel_setup_property_credentials      = true
hotel_setup_command_mode                     = "property_creation"
enable_hotel_setup_service_staging           = true
enable_hotel_setup_property_service_staging  = true
hotel_setup_image_digests = {
  primary  = "sha256:3316fce31bb4382def31ef37a7e6ff9d83d69ee6ea582ac1dcea8722551f827d"
  rollback = "sha256:259f22ca5f9d90cfa87239adfff6a396bd3877598372c20a377dc055dfd3df6b"
}
hotel_setup_property_image_digests = {
  primary  = "sha256:3316fce31bb4382def31ef37a7e6ff9d83d69ee6ea582ac1dcea8722551f827d"
  rollback = "sha256:259f22ca5f9d90cfa87239adfff6a396bd3877598372c20a377dc055dfd3df6b"
}
# Retain both admitted callers after the protected activation and native proofs.
# Later applies reject removal of installed origin/token pairs or enabled admission.
hotel_setup_public_caller = { creation = "enabled", property = "enabled" }
