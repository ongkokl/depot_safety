INSERT OR IGNORE INTO safety_checks
(id, category, check_question, guidance, source_title, source_url, keywords)
VALUES
('veh-001','Vehicular Safety',
 'Are pedestrian walkways and vehicle driveways clearly segregated and free from obstruction?',
 'Check that pedestrian walkways and vehicle routes are clearly demarcated, visible and kept free of obstructions.',
 'Workplace Traffic Safety Management',
 'https://www.tal.sg/wshc/topics/vehicular-safety/workplace-traffic-safety-management',
 'vehicle,truck,prime mover,pedestrian,walkway,traffic,driveway,banksman,road'),

('veh-002','Vehicular Safety',
 'Are traffic warning signs and workplace traffic controls clearly visible?',
 'Check for visible traffic signs, markings, barriers and controls appropriate to the workplace traffic arrangement.',
 'Workplace Traffic Safety Management',
 'https://www.tal.sg/wshc/topics/vehicular-safety/workplace-traffic-safety-management',
 'sign,marking,barrier,traffic,warning,road,vehicle'),

('veh-003','Vehicular Safety',
 'Is there evidence of a pedestrian being exposed to a moving or manoeuvring vehicle?',
 'Where people and vehicles interact, verify that suitable traffic controls and segregation are in place. AI observation requires on-site verification.',
 'Vehicular Safety',
 'https://www.tal.sg/wshc/topics/vehicular-safety',
 'reversing,vehicle,pedestrian,truck,prime mover,forklift,reach stacker,banksman'),

('house-001','Housekeeping',
 'Are walkways, work areas and access routes clean, orderly and free from obstruction?',
 'Check overall cleanliness, orderliness and uncluttered access routes.',
 'WSH Guidelines on Workplace Housekeeping',
 'https://www.tal.sg/wshc/topics/housekeeping/workplace-housekeeping',
 'housekeeping,obstruction,walkway,access,clutter,storage'),

('house-002','Housekeeping',
 'Are there visible spills, oily, wet or dirty surfaces that could create a slip hazard?',
 'Check for spilled substances and oily, wet or dirty surfaces and ensure hazards are controlled promptly.',
 'WSH Guidelines on Workplace Housekeeping',
 'https://www.tal.sg/wshc/-/media/tal/wshc/resources/publications/wsh-guidelines/files/wsh-guidelines-on-workplace-housekeeping.pdf',
 'oil,spill,water,wet,slip,housekeeping,floor'),

('ppe-001','PPE',
 'Are workers apparently wearing the PPE required for the visible activity?',
 'AI may identify visible PPE such as helmets or high-visibility vests, but actual PPE requirements must be verified against the risk assessment and site rules.',
 'WSH Council resources',
 'https://www.tal.sg/wshc',
 'helmet,hard hat,vest,hi-vis,gloves,safety shoes,ppe'),

('work-height-001','Work at Height',
 'Is there a visible fall hazard requiring fall prevention or protection?',
 'If work at height is visible, verify that suitable edge protection, safe access and fall prevention/protection measures are provided.',
 'WSH Council resources',
 'https://www.tal.sg/wshc',
 'height,ladder,scaffold,roof,edge,fall,platform'),

('lifting-001','Lifting',
 'Is a person apparently exposed to a suspended or lifting load?',
 'If lifting operations are visible, verify exclusion zones, lifting controls and that persons are not exposed to suspended loads.',
 'WSH Council resources',
 'https://www.tal.sg/wshc',
 'crane,lifting,suspended load,hook,sling,load')
;
