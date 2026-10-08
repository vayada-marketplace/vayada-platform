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
  primary  = "sha256:eacd03ed0c836b1d1e77e1b8fdb0ba5bb3a178b218700a627f6552534f60c846"
  rollback = "sha256:eacd03ed0c836b1d1e77e1b8fdb0ba5bb3a178b218700a627f6552534f60c846"
}
hotel_setup_property_image_digests = {
  primary  = "sha256:eacd03ed0c836b1d1e77e1b8fdb0ba5bb3a178b218700a627f6552534f60c846"
  rollback = "sha256:eacd03ed0c836b1d1e77e1b8fdb0ba5bb3a178b218700a627f6552534f60c846"
}
# VAY-2056 step 4: the public API runs hotel setup on its ordinary login and no longer reads
# the caller wiring. Every caller is retired: no admission, origin or token, the default
# execution role and no caller security group on the API task. tf-apply accepts dropping a
# caller only after the protected release blocked it (decommission step 1).
hotel_setup_public_caller = { creation = "off", property = "off", logo = "off", profile = "off" }

# Reviewed scoped logo protocol; automatic provisioning remains disabled.
enable_hotel_setup_logo_storage    = true
hotel_setup_logo_private_admission = "enabled"

# Exact property_profile native secret reads for the property task and protected bootstrap
# (VAY-965 profile edits). No caller admission, private task or image changes here.
enable_hotel_setup_profile_credentials = true
