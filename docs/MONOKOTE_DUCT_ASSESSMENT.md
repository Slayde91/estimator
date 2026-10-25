# Monokote duct assessment overlay

The runtime uses **BRANZ FC15909-01-03, 24 February 2026**, for the existing
four-sided Monokote duct schedule. The publisher's current report is available
at <https://tfire.com.au/documents/monokote-gcp-test-report>.

The complete 24-page PDF retrieved on 25 October 2026 has SHA-256
`474e3d3ca6abfe6b7d3017bccba6a4a8874b3a91751ffeb08b7f78baf712cd4c`.
Page 6 identifies this as issue 3; issue 2 was dated 16 February 2024.
This identifies the document reviewed, rather than asserting that the URL will
always serve the same edition.

## Thickness and existing choices

Tables 2 and 3 on page 14 and Table 4 on page 15 use these same body thicknesses:

| Existing schedule FRL | Internal, mm | External, mm | Both, mm |
| --- | ---: | ---: | ---: |
| 60/60/60 | 37 | 44 | 44 |
| 90/90/90 | 47 | 54 | 54 |
| 120/120/120 | 54 | 61 | 61 |
| 180/180/180 | 73 | 71 | 73 |
| 240/240/180 | 73 | 71 | 73 |

The external 44 and 54 mm report rows provide 120/120/60 and 120/120/90,
respectively, which cover the existing symmetric 60- and 90-minute selections.
The existing five FRL choices and their normalization remain unchanged. In
particular, the previously approved aliases `120/120/-` and `120/120/60`
continue to normalize to `120/120/120`; linking a new report does not silently
reinterpret saved selections or expose additional asymmetric FRLs.

The earlier workbook records 64 mm internally for the last two rows. The
overlay replaces that with 73 mm. Both keeps the greater directional result
for one duct quantity, rather than doubling material or claiming simultaneous
fire exposure. Unchanged yields and body geometry propagate the new thickness
to body volume, net bags and pooled totals. The Quantity factor still applies
once through the existing repeated-run rules.

## Coverage and qualifications

- Section 3.2, page 10, limits the rectangular section's longer/shorter side
  ratio to 4:1. Both dimensions must fit within 2400 mm. The overlay withholds
  report-derived material quantities outside these limits. Stricter retained
  reference ceilings remain effective; a larger ceiling cannot extend coverage.
- Small ducts are at most 1000 mm **wide** and 250 mm **high**, as entered.
  The next bounding group is 1500 by 1500 mm, followed by 2400 by 2400 mm.
  Identical thicknesses do not make their construction/support details equal.
- Sections 4.4.3–4.4.8, pages 13–15, specify steel, reinforcement, hanger,
  stiffener and tie-rod requirements. The source row's perimeter steel remains
  an estimating allowance, not a structural support design or cutting list.
- Section 4.5, pages 17–18, requires support at each floor, an intermediate
  support for spans above 5000 mm, and the 8:1 compartment/support-span rule.
  Schedule run length does not establish the compartment span, so it is not
  silently used as that measurement. The support condition is disclosed for
  installation review.
- The existing standard concrete/masonry assumptions and four-sided body
  takeoff remain. Lightweight/timber details, fewer exposed sides, adjoining
  services and FyreWrap junctions require their specific assessment details;
  their presence in the new report does not add new schedule controls.
- Local collar thickening, penetration infill and coating of supports are
  additional to the existing body-only volume and bags. No waste is added by
  this overlay.

The body tables label a Monokote thickness without defining a general field
mean/minimum acceptance tolerance. Background test averages are identified in
pages 7 and 11; section 4.4.2 instead uses measured thickness near insulation
failure in its analysis. No new averaging tolerance, point-minimum percentage,
or interpolation/extrapolation rule is inferred from that discussion. Use the
listed body-table thickness and verify the complete installation detail.

## Implementation boundary

`monokote_duct_assessment.application_formula_overrides` runs after the existing
duct and Quantity overrides. It changes Monokote-only assessment/scope,
status, source and qualification formulas. CAFCO and FyreWrap retain their
existing formulas. The original gzip, source formulas, literal reference values,
field addresses, saved inputs and pricing are unchanged.

`SETTINGS_DISPLAY_TEXT` supplies the current report's 73 mm values and page
locators to browser presentation only. The underlying literal source values
remain 64 mm, preserving the old workbook as an independent historical oracle.
Current schedule/report calculations use the reviewed 73 mm constants.

The focused tests cover all 135 combinations of the five existing FRLs, three
fire directions, three orientations and three size bands, plus scope rejection,
reference ceilings, legacy aliases, missing/blank Quantity, exact-once repeated
quantities, unchanged non-Monokote results and source-object preservation.
