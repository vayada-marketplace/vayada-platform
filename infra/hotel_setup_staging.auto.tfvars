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
  primary  = "sha256:18fa7587a09fa58916e734ea9c3b2d38c274783bc98d793308cc2f122d688965"
  rollback = "sha256:18fa7587a09fa58916e734ea9c3b2d38c274783bc98d793308cc2f122d688965"
}
hotel_setup_property_image_digests = {
  primary  = "sha256:18fa7587a09fa58916e734ea9c3b2d38c274783bc98d793308cc2f122d688965"
  rollback = "sha256:18fa7587a09fa58916e734ea9c3b2d38c274783bc98d793308cc2f122d688965"
}
# Retain both admitted callers after the protected activation and native proofs.
# Later applies reject removal of installed origin/token pairs or enabled admission.
hotel_setup_public_caller = { creation = "enabled", property = "enabled", logo = "hold" }

# Reviewed scoped logo protocol; automatic provisioning remains disabled.
enable_hotel_setup_logo_storage    = true
hotel_setup_logo_private_admission = "enabled"
