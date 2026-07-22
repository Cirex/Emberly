// work-order-tags.ts (promoted from apps/maintenance/lib/derived/wo-tags.ts)
//
// Work-order tag derivation — split out of the signals engine to keep that file to the
// duplicate/callback engine. Faithful 1:1 port of
// ResManClient.deriveWorkOrderTags(title:description:category:).
//
// Dependency-free and fully self-contained: it shares nothing with the
// duplicate/callback engine (its own text normalization + tag tables), which is
// why it moves out cleanly.

const WORK_ORDER_TAG_ORDER: string[] = [
  "HVAC",
  "Refrigerator",
  "Range",
  "Dishwasher",
  "Flooring",
  "Cabinets/Countertops",
  "Equipment",
  "Electrical",
  "Leaks",
  "Water Damage",
  "Rodents",
  "Pests",
  "Clogs",
  "Air Filter",
  "Mold",
  "Broken Window",
  "Windows/Screens/Blinds",
  "Doors/Locks",
  "Mail Box",
  "No Hot Water",
  "Set Out",
];

/** Faithful port of deriveWorkOrderTags(title, description, category). category is ignored (as in Swift). */
export function deriveWorkOrderTags(title: string, description: string, _category: string): string[] {
  let source = `${title}\n${description}`.toLowerCase();
  const normalizedReplacements: Array<[string, string]> = [
    ["\r", " "],
    ["\n", " "],
    ["\t", " "],
    ["a/c", " ac "],
    ["a.c.", " ac "],
    ["a. c.", " ac "],
    ["air conditioner", " ac "],
    ["air conditioning", " ac "],
    ["air-con", " ac "],
    ["aircon", " ac "],
    ["refrig", " fridge "],
    ["fridg", " fridge "],
    ["w/d", " washer dryer "],
    ["w-d", " washer dryer "],
    [".", " "],
    [",", " "],
    [";", " "],
    [":", " "],
    ["(", " "],
    [")", " "],
  ];
  for (const [pattern, replacement] of normalizedReplacements) {
    source = source.split(pattern).join(replacement);
  }
  while (source.includes("  ")) {
    source = source.split("  ").join(" ");
  }
  source = ` ${source.trim()} `;

  const containsAny = (phrases: string[]): boolean => phrases.some((p) => source.includes(p));

  if (containsAny([" make ready ", " make-ready ", " makeready "])) {
    return [];
  }
  // Batch turn-inspection checklists enumerate every trade in their boilerplate
  // ("Check for: … doors … windows … leaks/mold …"), so tagging off their text
  // tags everything. They're a walk template, not a reported fault — skip them.
  if (containsAny([" inspect ready unit", " unit walk inspection "])) {
    return [];
  }

  const tags = new Set<string>();
  const hasRangeContext = containsAny([
    " range ", " stove ", " oven ", " burner ", " burners ", " cooktop ", " microwave ",
  ]);
  const hasStrongElectricalContext = containsAny([
    " electrical ", " outlet ", " outlets ", " socket ", " sockets ", " receptacle ",
    " breaker ", " breaker box", " tripped breaker", " gfci ", " gfi ",
    " light switch", " switch plate", " light fixture", " light fixtures",
    " plugs are sparking", " plug sparking", " outlet sparking", " socket sparking",
    " shock", " shocking", " wiring ", " no power", " lost power", " power out",
    " power outage", " electric out", " lights are out", " lights out", " lighting ",
    " socket not working", " outlets not working",
  ]);
  const hasLooseElectricalSymptom = containsAny([
    " switch not", " switch doesnt", " switch doesn't", " sparking", " sparks",
  ]);
  const hasElectricalContext =
    hasStrongElectricalContext ||
    (hasLooseElectricalSymptom &&
      containsAny([" switch ", " outlet ", " socket ", " plug ", " plugs ", " breaker ", " light "]));
  const leakIndicatorPhrases = [
    " leak ", " leaks ", " leaking", " drips", " drip",
    " water leak", " water coming", " flooding", " flood",
    " wet floor", " wet carpet", " soaked", " standing water",
    " water stain", " ceiling stain", " ceiling leak",
    " pipe burst", " burst pipe", " line burst", " water heater leaking",
    " dripping", " pipe leak", " busted pipe ", " busted line ", " busted water line ",
  ];
  const hasLeakIndicators = containsAny(leakIndicatorPhrases);
  const hasExplicitClogIndicators = containsAny([
    " clog", " clogged", " clogging",
    " backed up", " backing up", " backup ",
    " slow drain", " slow draining", " not draining", " wont drain", " won't drain",
    " stopped up", " stopped-up",
    " will not flush", " won't flush", " not flushing ", " toilet is clogged ",
    " sewer", " main line", " mainline", " line clog",
    " drain slow", " stop up", " toilet backed up", " drain backed up",
  ]);
  const hasWaterHeatingEquipmentContext = containsAny([
    " water heater", " hot water heater", " hotwater heater", " hot water tank", " water tank", " boiler ",
  ]);
  const hasExplicitHVACContext =
    containsAny([
      " hvac ", " ac ", " air out", " air unit ", " air not working",
      " no air ", " no cold air ", " blowing warm air ", " blowing hot air",
      " heater ", " furnace ", " thermostat ", " thermastat ", " heat pump ",
      " air not circulating", " air circulation", " not circulating in all rooms",
    ]) && !hasWaterHeatingEquipmentContext;
  const hasDirectHeatComfortIssue =
    containsAny([
      " no heat", " heat not working", " heat is not working", " heat isn't working",
      " heat isnt working", " heat does not work", " heat doesn't work", " heat doesnt work",
      " heat still doesn't work", " heat still doesnt work", " heat is out", " heat out",
      " heat went out", " without heat", " heater not working", " heater out",
      " furnace not working", " furnace out", " no warm air",
    ]) && !hasWaterHeatingEquipmentContext;
  const hasThermostatRepairContext =
    containsAny([
      " thermostat not working", " thermastat not working", " thermostat do not work",
      " thermostat does not work", " thermostat doesn't work", " thermostat doesnt work",
      " thermostat isn't working", " thermostat isnt working", " thermostat need battery",
      " thermostat needs battery", " thermostat need batteries", " thermostat needs batteries",
      " thermostat possibly need batteries",
    ]) && !hasWaterHeatingEquipmentContext;
  const hasRefrigeratorContext = containsAny([
    " refrigerator", " refrigerator ", " fridge", " freezer",
    " replace ref", " replace refrigerator", " replace fridge", " ref not working",
    " swap refrigerator", " frige", " frige not woring properly",
    " bottom not cooling", " freezer does not work", " fridge not cold",
    " ice maker", " icemaker",
  ]);
  const hasExplicitHVACCoolingContext = containsAny([
    " hvac ", " ac ", " a/c ", " air conditioner", " air conditioning", " thermostat ",
    " thermastat ", " furnace ", " heat pump ", " condensing unit", " blowing warm air ",
    " blowing hot air", " no cold air ", " no air ", " air out", " air unit ",
  ]);
  const shouldSuppressHVACForRefrigeratorCooling = hasRefrigeratorContext && !hasExplicitHVACCoolingContext;
  const hasDishwasherContext = containsAny([" dishwasher", " dish washer"]);
  const hasLaundryApplianceContext = containsAny([
    " washer ", " washing machine ", " laundry machine ", " washer dryer ",
  ]);
  const hasApplianceWaterContext = hasRefrigeratorContext || hasDishwasherContext || hasLaundryApplianceContext;
  const hasDrainFixtureContext = containsAny([
    " sink ", " kitchen sink", " bathroom sink", " tub ", " bathtub", " shower ", " shower drain",
    " drain ", " disposal", " garbage disposal", " toilet ", " toilets ", " commode ", " commodes ",
    " sewer ", " main line",
    " mainline", " pipe ", " pipes ", " line ", " lines ",
  ]);
  const hasPlumbingLeakContext = containsAny([
    " sink ", " faucet ", " toilet ", " tub ", " bathtub", " shower ", " shower head", " drain ",
    " garbage disposal", " disposal", " pipe ", " pipes ", " water line", " plumbing ",
    " under sink", " under the sink", " behind toilet", " around toilet",
    " ceiling leak", " ceiling stain", " water stain", " wet carpet", " wet floor",
    " standing water", " flooding", " flood", " water heater",
  ]);
  const hasStructuralWaterContext = containsAny([
    " ceiling leak", " ceiling stain", " water stain", " wet carpet", " wet floor",
    " soaked", " standing water", " flooding", " flood", " water coming through",
    " water coming down", " from upstairs", " from ceiling", " upstairs leak",
    " leaking upstairs", " leaking from upstairs", " leak from upstairs",
    " water from upstairs", " water from ceiling", " ceiling leaking",
    " ceiling is leaking", " wall leaking", " walls leaking",
  ]);
  const hasPipeOrWaterHeaterLeakContext = containsAny([
    " pipe burst", " burst pipe", " line burst", " pipe leak", " water heater leaking",
    " hot water tank", " busted pipe ", " busted line ", " busted water line ", " water heater ",
  ]);
  const hasExplicitApplianceLeakContext =
    hasApplianceWaterContext &&
    containsAny([" leak ", " leaks ", " leaking", " drip", " drips", " water under ", " puddle "]);
  const hasRoomOrUnitLeakContext = containsAny([
    " bathroom ", " restroom ", " kitchen ", " hallway ", " cabinet ", " cabinets ",
    " wall ", " walls ", " ceiling ", " floor ", " carpet ", " closet ",
    " upstairs ", " downstairs ", " unit above", " apartment downstairs",
    " vacant apartment",
  ]);
  const hasHVACLeakContext = containsAny([
    " ac leak", " ac leaks", " ac leaking", " ac unit leaking", " ac unit is leaking",
    " air unit leaking", " air unit is leaking", " hvac leak", " hvac leaking",
  ]);
  const hasExplicitDrainContext = containsAny([
    " drain ", " drains ", " draining", " sewer ", " main line", " mainline",
    " flush", " flushing", " disposal", " garbage disposal",
  ]);
  const hasStrongDrainBackupContext = containsAny([
    " drain ", " drains ", " draining", " flush", " flushing", " clogged", " clogging",
    " backed up", " backing up", " overflow", " overflowing", " sewer ", " main line",
    " mainline", " line clog", " stopped up", " toilet backed up", " drain backed up",
    " wont drain", " won't drain", " slow drain", " slow draining", " not draining",
  ]);
  const hasSupplySideLeakContext = containsAny([
    " faucet ", " shower head", " under sink", " under the sink", " beneath sink",
    " sink base", " toilet base", " around toilet", " behind toilet",
    " pipe leak", " water line", " supply line", " valve ", " shut off valve",
    " hose bib", " shower valve", " tub spout", " when water is on", " when turning on water",
    " when faucet is on", " when shower is on",
  ]);
  const hasRodentContext = containsAny([
    " rodent", " mouse", " mice", " rat ", " rats ",
    " critter", " critters", " dead rat", " dead mouse",
    " rodent droppings", " rat droppings", " scratching in wall",
    " scratching noise", " animal in wall", " animal in attic",
    " animals in attic", " noise in attic", " scratching in attic",
    " chew ", " chewed", " chewing",
  ]);
  const hasSpecificPestContext = containsAny([
    " roach", " roaches", " cockroach", " cockroaches",
    " ant ", " ants", " gnat", " gnats",
    " fly", " flies", " fruit fly", " fruit flies",
    " flea", " fleas", " bedbug", " bed bug",
    " spider", " spiders", " insect", " insects",
  ]);
  const hasGenericPestContext = containsAny([
    " pest", " pests", " bug ", " bugs ", " bug problem", " bug issue",
    " bug infestation", " infestation", " infested", " insect problem",
    " insect issue", " pest control", " exterminator", " fumigation",
    " spraying for bugs", " bugs in unit", " bugs in apartment",
  ]);
  const hasFloorSurfaceContext = containsAny([
    " flooring ", " carpet ", " vinyl plank ", " lvp ",
    " laminate floor ", " tile floor ", " wood floor ", " hardwood floor ",
    " subfloor ", " baseboard ", " floor tile ", " floor board ", " floor boards ",
  ]);
  const hasFlooringRepairContext = containsAny([
    " floor coming up ", " floor replaced ", " replace floor ", " floor repair ",
    " flooring repair ", " flooring replaced ", " carpet repair ", " replace carpet ",
    " carpet replaced ", " tile repair ", " tile cracked ", " tile broken ",
    " vinyl plank coming up ", " lvp coming up ", " laminate coming up ",
    " transition strip ", " soft spot in floor ", " sagging floor ", " loose tile ",
    " torn carpet ", " ripped carpet ", " stained carpet ", " buckling floor ",
    " warped floor ", " peeling floor ", " flooring damage ",
  ]);
  const hasExplicitMoldContext = containsAny([
    " mold", " mould", " mildew", " black mold", " moldy", " mildewed",
  ]);
  const hasMoldRemediationContext = containsAny([
    " mold remediation", " mildew remediation", " remove mold", " mold treatment",
    " mildew treatment", " kill mold", " mold testing",
  ]);
  const hasMustyMoistureContext = containsAny([
    " musty", " mildew smell", " mold smell", " moldy smell", " musty smell",
    " moisture in wall", " moisture on wall", " wet wall", " damp wall",
    " bathroom ceiling", " shower ceiling", " ceiling discoloration",
  ]);
  const hasVisibleGrowthOrMoistureSurface = containsAny([
    " on wall", " on ceiling", " around tub", " around shower", " in bathroom",
    " bathroom wall", " bathroom ceiling", " around vent", " visible growth",
    " growing on", " black spots", " dark spots",
  ]);
  const hasWaterHeaterContext = hasWaterHeatingEquipmentContext;
  const hasHotWaterFixtureContext = containsAny([
    " shower ", " bathtub", " tub ", " faucet ", " sink ", " bathroom sink", " kitchen sink",
    " shower head", " bath ", " bathroom ",
  ]);
  const hasExplicitNoHotWaterSymptoms = containsAny([
    " no hot water", " not getting hot water", " no warm water", " no heated water",
    " hot water isn't working", " hot water is not working", " hot water not working",
    " water isn't getting hot", " water is not getting hot", " water not hot",
    " shower still not getting hot", " shower has no hot water", " shower not getting hot",
    " faucet not getting hot", " sink not getting hot", " no hot water in unit",
    " only cold water", " no warm shower", " shower only gets cold",
  ]);
  const hasHotWaterWarmthProblem = containsAny([
    " luke warm", " lukewarm", " barely warm", " only warm", " not hot enough",
    " turn up the hot water", " turned up", " turn up water heater", " turn up hot water tank",
    " water not hot enough", " hot water not hot enough",
  ]);
  const hasWaterHeaterFailureContext =
    hasWaterHeaterContext &&
    containsAny([
      " not working", " isn't working", " is not working", " broken ", " out ",
      " no hot water", " no pilot", " pilot out", " reset ", " heating element",
      " not heating", " won't heat", " wont heat",
    ]);
  const shouldTagNoHotWater =
    hasExplicitNoHotWaterSymptoms ||
    (hasHotWaterFixtureContext && hasHotWaterWarmthProblem) ||
    (hasWaterHeaterContext && hasHotWaterWarmthProblem) ||
    hasWaterHeaterFailureContext;

  // --- New concrete structure + water-damage tags (approved 2026-07-19). -----
  // Structure is split into concrete trades — Doors/Locks, Windows/Screens/
  // Blinds, Cabinets/Countertops — rather than a single vague "Structure".
  // Water Damage covers dried stains and the REPAIR of past water intrusion and
  // is kept DISTINCT from an active Leak: active dripping wins (Leaks only),
  // while a leak explicitly framed as past/repaired, or a bare stain with no
  // live water, routes to Water Damage instead ("active wins, past → Water
  // Damage", never both — the 2026-07-19 review decision).
  const hasMailboxContext = containsAny([
    "mailbox", "mail box", "mail-box", "cluster box", "parcel", "mail slot",
  ]);
  const hasCabinetContext = containsAny([
    " cabinet ", " cabinets", " cabinet door", " kitchen cabinet", " countertop",
    " counter top", " counters ", " counter ", " drawer ", " drawers ", " vanity ",
  ]);
  const hasDoorHardwareContext = containsAny([
    " door ", " doors ", " doorknob", " door knob", " deadbolt", " dead bolt",
    " door lock", " door strip", " door hinge", " door frame", " front door",
    " back door", " bedroom door", " closet door", " screen door", " sliding door",
    " patio door", " storm door", " weather strip", " weatherstrip", " weather stripping",
  ]);
  const hasLockContext = containsAny([
    " lock ", " locks ", " locked ", " unlock", " re-lock", " latch ", " keyed ",
  ]);
  const hasWindowCoveringContext = containsAny([
    " blind ", " blinds ", " mini blind", " miniblind", " shade ", " shades ",
    " screen ", " screens ", " curtain ", " curtains ", " curtain rod",
  ]);
  const hasWindowStructureContext = containsAny([
    " window ", " windows ", " windowpane", " window pane", " pane ", " panes ",
    " window seal", " window latch", " window lock", " window frame", " window sill",
    " sliding window", " storm window", " glass replacement",
  ]);
  // A "window unit" / "window AC" is a through-the-wall air conditioner, not a
  // window covering — don't let it read as a Windows/Screens/Blinds job.
  const hasWindowAcContext = containsAny([" window unit", " window ac", " window a c ", " window air"]);
  // A running / won't-shut-off toilet wastes water continuously → treat as a
  // Leak (per the 2026-07-19 decision that toilet issues fall under leak/clog).
  const hasRunningToiletContext =
    containsAny([" toilet ", " toilets ", " commode "]) &&
    containsAny([
      " running", " go off", " wont stop", " won t stop", " will not stop",
      " constantly", " wont shut off", " won t shut off", " wont cut off",
      " won t cut off", " nonstop", " non stop",
    ]);
  const hasWaterDamageEvidence = containsAny([
    " water stain", " water stains", " water damage", " water damaged",
    " ceiling stain", " ceiling stains", " stained ceiling", " stain on ceiling",
    " stain on the ceiling", " wall stain", " wall stains", " stained wall",
    " brown stain", " brown spot", " water spot", " water spots", " sheetrock",
    " sheet rock", " drywall", " dry wall", " plaster ", " ceiling plaster",
    " sagging ceiling", " ceiling sagging", " ceiling caving", " ceiling collapsed",
    " ceiling fell", " ceiling is falling", " ceiling discoloration",
    " wall discoloration", " bubbling ceiling",
  ]);
  const hasActiveWaterIntrusion = containsAny([
    " leaking", " leaks ", " leak ", " dripping", " drips", " drip ",
    " flooding", " flood ", " pouring", " gushing", " water coming",
    " standing water", " wet floor", " wet carpet", " soaked", " overflowing",
  ]);
  const hasPastOrRepairedLeakContext = containsAny([
    " previous leak", " prevoius leak", " prior leak", " old leak", " past leak",
    " former leak", " from the leak", " from a leak", " from leak", " since the leak",
    " after the leak", " leak repaired", " leak was repaired", " leak has been repaired",
    " repaired leak", " previously leak", " where the leak was", " after roof repair",
    " from prevoius leak", " from previous leak",
  ]);
  const mentionsLeakWord = containsAny([" leak ", " leaks ", " leaking", " drip", " drips", " dripping"]);
  // Active = live water intrusion NOT framed as a past/repaired leak.
  const hasActiveLeak = hasActiveWaterIntrusion && !hasPastOrRepairedLeakContext;
  // Route to Water Damage (and suppress Leaks) when the damage is dried/structural
  // or the leak is explicitly past, and no active water is present.
  const isWaterDamageOnly =
    (hasWaterDamageEvidence || (mentionsLeakWord && hasPastOrRepairedLeakContext)) && !hasActiveLeak;

  if (
    hasDirectHeatComfortIssue ||
    hasThermostatRepairContext ||
    (hasExplicitHVACContext &&
      containsAny([
        "no heat", "not heating", "heat not working", "heater not working",
        "heating not working", "furnace not working", "heater out",
        "heat out", "hvac heat", "heat pump not working",
        "without heat", "heat doesnt work", "heat doesn't work",
        "no heat in unit", "heat still doesn't work", "thermostat not working",
        "heat isnt", "heat isn't", "heater not", "furnace out",
        "no warm air", "wont heat", "won't heat",
      ]))
  ) {
    tags.add("HVAC");
  }
  if (
    containsAny([
      "no cool", "not cooling", "ac not working", "a/c not working",
      "air conditioning not working", "cooling not working", "not getting cold",
      "hvac out", "ac out", "a/c out", "air out", "air still not fixed",
      "air not fixed", "still not fixed", "heat and air out", "unit not cooling",
      "air conditioner not working", "condensing unit not working",
      "air not working", "air not working at all", "without ac",
      "blowing hot air", "blowing hot", "full hvac system not working",
      "hvac system not working", "unit is still blowing hot", "thermastat not working",
      "air not circulating", "air isn't circulating", "air isnt circulating",
      "not circulating in all rooms", "air circulation problem",
      " ac not ", " ac isnt ", " ac isn't ", " ac is out ",
      " ac broken ", " ac wont ", " ac won't ", " no ac ", " no air ",
      " no cold air ", " blowing warm air ", " hvac not ", " hvac broken ",
      " wont cool ", " won't cool ", " air unit is out ", " air unit is out and not working ",
      " air isn't blowing cool ", " air isnt blowing cool ",
    ]) &&
    !shouldSuppressHVACForRefrigeratorCooling &&
    !hasWaterHeatingEquipmentContext
  ) {
    tags.add("HVAC");
  }
  if (
    hasRefrigeratorContext &&
    !(hasElectricalContext && containsAny([" freezer ", " deep freezer ", " fridge ", " refrigerator "]))
  ) {
    tags.add("Refrigerator");
  }
  if (
    hasRangeContext ||
    containsAny([
      " stovetop ", " oven door ", " oven light ", " broiler ", " bake element ",
      " heating element ", " range hood ",
    ])
  ) {
    tags.add("Range");
  }
  if (hasDishwasherContext) {
    tags.add("Dishwasher");
  }
  if (
    hasFlooringRepairContext ||
    (hasFloorSurfaceContext &&
      containsAny([
        " replace ", " repair ", " damaged ", " damage ", " torn ", " ripped ",
        " loose ", " cracked ", " broken ", " stained ", " warped ", " buckling ",
        " peeling ", " coming up ",
      ]))
  ) {
    tags.add("Flooring");
  }
  if (containsAny([" equipment return ", " equipment ", " return equipment "])) {
    tags.add("Equipment");
  }
  const shouldSuppressElectricalForApplianceContext =
    (hasRangeContext || hasRefrigeratorContext || hasDishwasherContext) &&
    !containsAny([
      " outlet ", " outlets ", " socket ", " sockets ", " breaker ", " gfci ", " gfi ",
      " light switch", " light fixture", " receptacle ", " wiring ", " power outage",
      " power out", " no power", " lost power", " electric out", " lighting ",
      " switch not", " switch doesnt", " switch doesn't",
    ]);
  if (hasElectricalContext && !shouldSuppressElectricalForApplianceContext) {
    tags.add("Electrical");
  }
  if (hasLeakIndicators && (source.includes(" window ") || source.includes(" glass ")) && source.includes(" busted ")) {
    tags.add("Broken Window");
  }

  const shouldSuppressLeakForPureClog =
    hasExplicitClogIndicators &&
    !containsAny([
      " leak ", " leaks ", " leaking", " drip", " drips", " ceiling leak", " pipe leak",
      " water heater leaking ",
    ]);
  const hasQualifiedLeakContext =
    hasPlumbingLeakContext ||
    hasStructuralWaterContext ||
    hasPipeOrWaterHeaterLeakContext ||
    hasHVACLeakContext ||
    (hasRoomOrUnitLeakContext && !hasExplicitApplianceLeakContext);
  const shouldSuppressLeakForApplianceContext = hasExplicitApplianceLeakContext && !hasQualifiedLeakContext;
  if (
    hasLeakIndicators &&
    hasQualifiedLeakContext &&
    !shouldSuppressLeakForPureClog &&
    !shouldSuppressLeakForApplianceContext &&
    !isWaterDamageOnly
  ) {
    tags.add("Leaks");
  }
  if (hasRunningToiletContext) {
    tags.add("Leaks");
  }
  if (isWaterDamageOnly) {
    tags.add("Water Damage");
  }

  if (hasRodentContext) {
    tags.add("Rodents");
  }
  const shouldTagPests = hasSpecificPestContext || (hasGenericPestContext && !hasRodentContext);
  if (shouldTagPests) {
    tags.add("Pests");
  }

  const shouldSuppressClogForLeak =
    hasLeakIndicators &&
    (hasSupplySideLeakContext || (hasPlumbingLeakContext && !hasStrongDrainBackupContext)) &&
    !hasStrongDrainBackupContext;
  const shouldSuppressClogForApplianceContext =
    hasApplianceWaterContext && !hasDrainFixtureContext && !hasExplicitDrainContext;
  if (
    hasExplicitClogIndicators &&
    !shouldSuppressClogForLeak &&
    (hasDrainFixtureContext || hasExplicitDrainContext) &&
    !shouldSuppressClogForApplianceContext
  ) {
    tags.add("Clogs");
  }
  if (
    containsAny([
      " filter", " air filter", " change filter", " dirty filter",
      "ac filter", "a/c filter", "hvac filter", "filter change", "no ac filter", "needs filter",
    ])
  ) {
    tags.add("Air Filter");
  }
  const shouldTagMold =
    hasExplicitMoldContext ||
    hasMoldRemediationContext ||
    (hasMustyMoistureContext && hasVisibleGrowthOrMoistureSurface);
  if (shouldTagMold) {
    tags.add("Mold");
  }
  const hasWindowDamagePhrase = containsAny([
    " broken glass", " glass broken", " glass repair", " glass can be ordered",
    " shot through the glass", " broken window", " broke window", " broke my window",
    " broke our window", " window broke", " window broken", " window is broken",
    " window was broken", " window facing", " replace window", " window need replaced",
    " window needs replaced", " window needs to be replaced", " busted window",
    " window is busted", " window was busted", " window busted", " busted out",
    " cracked window", " window crack", " window is cracked", " window has a hole",
    " hole in window", " shattered window",
  ]);
  const hasWindowDamageContext =
    (source.includes(" window ") || source.includes(" glass ") || source.includes(" pane ")) &&
    containsAny([
      " broken ", " broke ", " busted ", " cracked ", " crack ", " shattered ",
      " shot ", " shot through ", " hole ", " glass repair", " glass can be ordered",
    ]) &&
    !containsAny([
      " blinds ", " blind ", " screens ", " screen ", " weather strip",
      " weather stripping", " seal ", " window seal", " caulk ", " latch ",
      " shade ", " curtain ",
    ]);
  if (hasWindowDamagePhrase || hasWindowDamageContext) {
    tags.add("Broken Window");
  }
  // Non-breakage window work (screens, blinds, seals, frames, glass swaps) is a
  // separate trade from Broken Window; a plain broken pane stays Broken Window
  // only, but an independent covering/screen/blind issue always tags here.
  if (
    hasWindowCoveringContext ||
    (hasWindowStructureContext && !hasWindowAcContext && !tags.has("Broken Window"))
  ) {
    tags.add("Windows/Screens/Blinds");
  }
  if (hasDoorHardwareContext || (hasLockContext && !hasMailboxContext)) {
    tags.add("Doors/Locks");
  }
  if (hasCabinetContext) {
    tags.add("Cabinets/Countertops");
  }
  if (
    containsAny([
      "mailbox", "mail box", "mail-box", "cluster box",
      "parcel locker", "parcel box", "mail slot",
      "mailboxkey", "mailboxlock", "mailboxdoor",
    ])
  ) {
    tags.add("Mail Box");
  }
  if (shouldTagNoHotWater) {
    tags.add("No Hot Water");
  }
  if (containsAny(["set out", "set-out"])) {
    tags.add("Set Out");
  }

  if (hasRangeContext) {
    tags.delete("HVAC");
  }
  if (shouldSuppressHVACForRefrigeratorCooling) {
    tags.delete("HVAC");
  }

  return WORK_ORDER_TAG_ORDER.filter((t) => tags.has(t));
}
