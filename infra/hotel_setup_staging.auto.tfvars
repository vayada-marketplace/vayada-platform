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
  primary  = "sha256:c2fbba1a4d3f8f7bc4c46d0816f125d3598cd1c1a4880dd3b103feb0d3aa67d2"
  rollback = "sha256:ac29c768aca69f1f0710e4278340f06031fc7f619b6c67d0cbc221b539ac2bac"
}
hotel_setup_property_image_digests = {
  primary  = "sha256:b673453b253fac2e94822c24158f6d599696d0fb71a2bc68c7f4a3be0f98f38a"
  rollback = "sha256:9c6ad66294c188ff16b141922cc3cc57d0fc7dd7dfd45eda59e4c4492bb51f79"
}
# Retain private token references while admission remains blocked.
# The protected release enables admission after native proofs and service readiness.
# Later applies reject removal of installed origin/token pairs or enabled admission.
hotel_setup_public_caller = { creation = "blocked", property = "blocked" }
