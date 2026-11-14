"""Retire catalogue choices from live pricing without rewriting frozen estimates."""

from .catalog import baseline, catalog_signature, product_service_name, validate_configuration


def active_configuration(value):
    """Return validated, editable pricing with the retired access and labour uses removed.

    The source workbook also serves legacy quotes with no embedded catalogue.
    Keep it intact and materialise the reduced catalogue only for current pricing.
    """
    config = validate_configuration(value)
    catalog = config.get("catalog") or baseline()
    uses = {}
    for group, rates in catalog["rate_groups"].items():
        for rate in rates:
            if rate.get("inventory_id") is not None:
                uses.setdefault(rate["inventory_id"], []).append((group, rate))

    products, removed_products, removed_rates = [], set(), set()
    for product in catalog["inventory"]:
        key = product["id"]
        linked = uses.get(key, [])
        current = {**product, **config["inventory"].get(key, {})}
        label = product_service_name(current, linked).strip().casefold()
        groups = {group for group, _ in linked}
        # The original scissor lifts, EWPs and Athena have no estimator group;
        # match the equipment family too, rather than deleting unrelated rentals.
        equipment = (current["name"] + " " + label).casefold()
        hire = "access_hire" in groups or any(
            family in equipment for family in ("scissor", "athena", "ewp", "boom lift", "access platform")
        )
        labour = "labour_rates" in groups
        if (hire and label.endswith("daily hire")) or (labour and label.endswith("(sheeting)")):
            removed_products.add(key)
        else:
            products.append(product)
    catalog["inventory"] = products
    for group, rates in catalog["rate_groups"].items():
        kept = []
        for rate in rates:
            current = {**rate, **config["rates"].get(rate["id"], {})}
            label = product_service_name(records=[current]).strip().casefold()
            if (rate.get("inventory_id") in removed_products
                or (group == "access_hire" and label.endswith("daily hire"))
                or (group == "labour_rates" and label.endswith("(sheeting)"))):
                removed_rates.add(rate["id"])
            else:
                kept.append(rate)
        catalog["rate_groups"][group] = kept
    if removed_products or removed_rates:
        config["catalog"] = catalog
        for key in removed_products:
            config["inventory"].pop(key, None)
        for key in removed_rates:
            config["rates"].pop(key, None)
        if "catalog_signature" in config:
            config["catalog_signature"] = catalog_signature(catalog)
    return config
