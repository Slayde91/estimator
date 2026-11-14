(() => {
  "use strict";
  const i18n = window.CeasefireI18n;
  const currency = new Intl.NumberFormat("en-AU", {style:"currency", currency:"AUD"});
  const percent = new Intl.NumberFormat("en-AU", {style:"percent", maximumFractionDigits:1});
  const money = cents => currency.format(cents / 100);

  function element(tag, text, className, args = []) {
    const item = document.createElement(tag);
    if (text != null) i18n.text(item, text, args);
    if (className) item.className = className;
    return item;
  }
  function svgNode(tag, attributes) {
    const item = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name,value] of Object.entries(attributes)) item.setAttribute(name,value);
    return item;
  }
  function pie(rows) {
    const host = element("div", null, "work-cost-graphic");
    const svg = svgNode("svg", {viewBox:"-101 -101 202 202", role:"group"});
    i18n.attr(svg,"aria-label","Work Order cost breakdown");
    const tip = element("span", null, "work-cost-tooltip");
    tip.hidden = true;
    const total = rows.reduce((sum,row) => sum + Math.max(row.amount,0), 0);
    let start = 0;
    const point = fraction => {
      const angle = Math.PI * (2 * fraction - 0.5);
      return [100 * Math.cos(angle), 100 * Math.sin(angle)];
    };
    for (const row of rows) {
      if (row.amount <= 0) continue;
      const end = start + row.amount;
      const slice = row.amount === total ? svgNode("circle", {r:100}) : svgNode("path", {
        d:"M0,0 L" + point(start/total) + " A100,100 0 " + (row.amount > total/2 ? 1 : 0) + " 1 " + point(end/total) + " Z"
      });
      slice.setAttribute("class",row.style);
      slice.setAttribute("tabindex","0");
      slice.setAttribute("role","img");
      i18n.attr(slice,"aria-label","{0}: {1}",row.labelArgs);
      for (const event of ["pointerenter","focus"]) slice.addEventListener(event,() => {i18n.text(tip,"{0}: {1}",row.labelArgs); tip.hidden=false;});
      for (const event of ["pointerleave","blur"]) slice.addEventListener(event,() => {tip.hidden=true;});
      svg.append(slice);
      start = end;
    }
    host.append(svg,tip);
    return host;
  }

  function attach(parent, options) {
    const card = element("section", null, "card work-order-costs");
    parent.append(card);
    let labour, ticket = 0;
    function paint() {
      if (!options.current()) return;
      const raw = options.estimate();
      const estimate = raw == null || String(raw).trim() === "" ? NaN : Math.round(Number(raw) * 100);
      card.replaceChildren(element("h3", "Work Order costs"));
      if (!Number.isFinite(estimate) || estimate < 0) {
        card.append(element("p", "Enter an estimated cost to see the breakdown.", "helper"));
        return;
      }
      card.append(element("p", "Estimated cost {0}", "work-cost-estimate", [money(estimate)]));
      if (labour?.amount == null) {
        card.append(element("p", labour?.message || "Loading time entry costs…", "helper"));
        return;
      }
      const purchases = Number(options.purchases()), time = Math.round(Number(labour.amount) * 100);
      const balance = estimate - purchases - time;
      const rows = [
        {name:"Remaining estimate", style:"work-cost-remaining", amount:Math.max(0,balance)},
        {name:"Purchase orders", style:"work-cost-orders", amount:purchases},
        {name:"Time entries", style:"work-cost-time", amount:time}
      ];
      const legend = element("ul", null, "work-cost-legend");
      for (const row of rows) {
        // Percentages stay relative to the estimate, including overruns. A zero budget
        // has no meaningful percentage, although spending still contributes to loss.
        const share = estimate ? percent.format(row.amount/estimate) + " - " : "";
        row.labelArgs = [i18n.term(row.name), share + money(row.amount)];
        const line = element("li"), swatch = element("span", null, row.style);
        swatch.setAttribute("aria-hidden","true");
        line.append(swatch, element("span", row.name), element("strong", money(row.amount)));
        legend.append(line);
      }
      if (rows.some(row => row.amount > 0)) card.append(pie(rows));
      card.append(legend);
      if (balance < 0) card.append(element("strong", "Loss {0}", "work-cost-loss", [money(balance)]));
      if (labour.message) card.append(element("p", labour.message, "helper"));
    }
    async function refresh() {
      const version = ++ticket;
      labour = null;
      paint();
      try {
        const result = await options.labour();
        if (version !== ticket || !options.current()) return;
        labour = result;
      } catch (error) {
        if (version !== ticket || !options.current()) return;
        labour = {message:error.message || "Time entry costs could not be loaded."};
      }
      paint();
    }
    void refresh();
    return {refresh,paint};
  }
  window.ClassifireWorkOrderCosts = {attach};
})();
