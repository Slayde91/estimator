"""Maintain the current pricing library without rewriting frozen estimates."""

from .catalog import baseline, catalog_signature, product_service_name, validate_configuration


_RATE_PRICE_FIELDS = {"price", "supplier_price", "markup"}


def active_configuration(value):
    """Return current pricing with retired uses removed and linked prices reconciled.

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
    product_prices = {product["id"]: product["sales_price"] for product in products}
    linked_prices_changed = False
    for group, rates in catalog["rate_groups"].items():
        kept = []
        for rate in rates:
            key = rate["id"]
            owner = rate.get("inventory_id")
            patch = config["rates"].get(key, {})
            current = {**rate, **patch}
            label = product_service_name(records=[current]).strip().casefold()
            if (owner in removed_products
                or (group == "access_hire" and label.endswith("daily hire"))
                or (group == "labour_rates" and label.endswith("(sheeting)"))):
                removed_rates.add(key)
                continue
            if owner is not None:
                # Use the base product price here. The calculator applies
                # product-level price edits to inventory-priced uses later.
                price = product_prices[owner]
                if (rate["price"] != price or rate.get("price_mode", "inventory") != "inventory"
                    or {"supplier_price", "markup"} & rate.keys()):
                    rate.update(price=price, price_mode="inventory")
                    rate.pop("supplier_price", None)
                    rate.pop("markup", None)
                    linked_prices_changed = True
                if _RATE_PRICE_FIELDS & patch.keys():
                    retained = {field: value for field, value in patch.items() if field not in _RATE_PRICE_FIELDS}
                    if retained:
                        config["rates"][key] = retained
                    else:
                        del config["rates"][key]
            kept.append(rate)
        catalog["rate_groups"][group] = kept
    if removed_products or removed_rates or linked_prices_changed:
        config["catalog"] = catalog
        for key in removed_products:
            config["inventory"].pop(key, None)
        for key in removed_rates:
            config["rates"].pop(key, None)
        if "catalog_signature" in config:
            config["catalog_signature"] = catalog_signature(catalog)
    return config
