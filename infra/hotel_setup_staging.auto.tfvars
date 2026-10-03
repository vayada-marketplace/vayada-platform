# Reviewed VAY-965 prerequisite infrastructure. Services remain at zero tasks.
# Keep these prerequisites enabled after activation; lifecycle guards retain live tasks.
enable_hotel_setup_private_network           = true
enable_hotel_setup_property_network          = true
enable_hotel_setup_credential_infrastructure = true
enable_hotel_setup_property_credentials      = true
hotel_setup_command_mode                     = "property_creation"
enable_hotel_setup_service_staging           = true
enable_hotel_setup_property_service_staging  = true
hotel_setup_image_digests = {
  primary  = "sha256:29d50e0373685f881916c5be93525db178c087ce5e7a53124e6429519ff583f1"
  rollback = "sha256:87c174a77842fda075b6c4784054f95bcc685d6f3d35c91d7b8bd08f174eafb8"
}
hotel_setup_property_image_digests = {
  primary  = "sha256:b673453b253fac2e94822c24158f6d599696d0fb71a2bc68c7f4a3be0f98f38a"
  rollback = "sha256:9c6ad66294c188ff16b141922cc3cc57d0fc7dd7dfd45eda59e4c4492bb51f79"
}
# Retain private token references while admission remains blocked.
# The protected release enables admission after native proofs and service readiness.
# Later applies reject removal of installed origin/token pairs or enabled admission.
hotel_setup_public_caller = { creation = "blocked", property = "blocked" }
