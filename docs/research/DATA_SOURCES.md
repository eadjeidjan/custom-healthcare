# SickleGuard: Data Sources & Evidence Base for 7-day VOC Risk Prediction

_Research compiled 2026-11-10. Companion file: `sim_params.json` (machine-readable simulator parameters)._

**Confidence key:** **[V]** checked against the abstract or source page during this review · **[S]** taken from a secondary source or search summary (cross-check before publication) · **[U]** unverified (from memory or not located); treat as a placeholder.

> Bottom line: no public dataset combines **daily wearable signals** and **VOC outcomes** in SCD. Clinical cohort and registry data (BioLINCC, BioData Catalyst, the SickleInAfrica/Kumasi registry) can calibrate **baseline risk and covariate effects**. Evidence linking wearables to crises comes from small pilot studies (n ≈ 12–19) that are mostly not shared. Until SickleGuard collects its own prospective data, treat the wearable part of the simulator as hypothesis-level.

---

## 1. Real datasets

### 1.1 NHLBI BioLINCC: legacy US cohort studies and trials
Portal: https://biolincc.nhlbi.nih.gov · General access route: register, submit a request with a research plan, show local IRB approval or exemption, and sign the BioLINCC Data Use Agreement. Data are free. Turnaround is typically a few weeks to about 3 months **[U]**.

| Study | Contents | Outcomes | Relevance | Access notes |
|---|---|---|---|---|
| **CSSCD** (Cooperative Study of SCD, 1977–1995) https://biolincc.nhlbi.nih.gov/studies/csscd | Phase 1: 4,085 participants (newborns to adults) at 23 US centres **[S]**. Includes genotype, steady-state labs (Hb, HbF, WBC, retics, etc.) and α-thal status | Pain episodes (12,290 episodes over 18,356 patient-years, Platt 1991 **[V]**), ACS (Castro 1994), AVN (Milner 1991), stroke, death | **Best source for baseline rates and lab–outcome associations by genotype and age.** No wearables. US data from the pre-hydroxyurea era | Registration, IRB, DUA. Only Phase 2a adult biospecimens are available **[S]** |
| **MSH** (Multicenter Study of Hydroxyurea, 1992–95) https://biolincc.nhlbi.nih.gov/studies/MSH | 299 adults with HbSS and ≥3 crises/yr; randomised HU vs placebo; serial labs (HbF, MCV, WBC, retics) | Painful crises (median 2.5 vs 4.5/yr), ACS (25 vs 51 patients), transfusions (Charache 1995 **[V]**) | Hydroxyurea effect size; within-person lab trajectories over about 2 years in a high-frequency-crisis group | Listed on BioLINCC and BioData Catalyst, "no data restriction" per the RTI CureSCi listing **[S]** |
| **walk-PHaSST** (2007–09) https://biolincc.nhlbi.nih.gov/studies/walk_phasst/ | Screening cohort of about 700 adults **[U]** with echo (TRV), NT-proBNP, labs and 6-minute walk | Sildenafil arm stopped early because of increased hospitalisation for pain **[U]** | Contemporary adult labs (LDH, bilirubin, retics) and hemolysis markers | Consent restricts use to SCD-related research **[S]** |
| **C-Data** (Comprehensive Sickle Cell Centers Collaborative Data Project) https://biolincc.nhlbi.nih.gov/studies/cscc_c_data/ | Multi-centre US clinical registry from the 2000s **[U]**, with visits and acute events | ED visits and hospitalisations **[U]** | Modern-era event rates including hydroxyurea users | BioLINCC request |
| Others to check on BioLINCC: **STOP / STOP II** (TCD), **SIT** (silent infarcts), **BABY HUG**, **SWiTCH**, **SCDIC registry** | TCD, MRI and paediatric HU data | Stroke, SCI, pain, ACS | Imaging priors (TCD and SCI) | Same route **[U: availability of each not checked]** |

### 1.2 NHLBI Cure Sickle Cell Initiative (CureSCi) and BioData Catalyst
- **CureSCi Metadata Catalog** (open, no login) lists SCD studies and their data elements, so you can map variables before requesting anything: https://curesicklecell.rti.org/Study (PLOS ONE 2022, doi:10.1371/journal.pone.0256248) **[S]**.
- **Natural History Data Resource (NHDR)** pools SCD cohort data to provide contemporary control cohorts. It is loaded to BioData Catalyst every January. Access is through a **dbGaP Data Access Request**, then analysis in BDC cloud workspaces: https://curesicklecell-nhdr.rti.org/data-sharing **[S]**.
- **What it gives SickleGuard:** harmonised, modern-era clinical data across many studies (including MSH and probably SCDIC and GRNDaD-like registries **[U]**).
- **Cost and time:** free. dbGaP applications need an eRA Commons/institutional signing official and typically take 4–8 weeks **[U]**. A Ghanaian institution can apply, but a US-registered collaborator speeds things up **[U]**.

### 1.3 CDC Sickle Cell Data Collection (SCDC) program
- Population-based surveillance that links newborn screening, hospital discharge, ED, Medicaid and vital records. It now covers about 16 US states: https://www.cdc.gov/sickle-cell/scdc/index.html **[S]**.
- **Access:** identifiable individual-level data **are not shared** with external researchers or with CDC. External researchers can collaborate with state SCDC scientists, who run the analyses and release only summary results: [CDC data-to-action report](https://archive.cdc.gov/www_cdc_gov/ncbddd/hemoglobinopathies/data-reports/2018-summer/data.html) **[S]**. Published summaries are available (e.g. MMWR SS 71(9), CA & GA 2004–2018: https://www.cdc.gov/mmwr/volumes/71/ss/ss7109a1.htm).
- **Relevance:** annual ED and hospitalisation rates by age, for calibrating the US comparator only. **First step:** use the published MMWR tables; contact a state team only if a collaboration is justified.

### 1.4 CIBMTR
- Registry of SCD haematopoietic cell transplants and gene therapy. Outcomes after transplant (VOC usually resolves) are **not relevant to VOC prediction** in untreated patients. CIBMTR does post de-identified "publication analysis datasets" on its website **[U]**. **Recommendation: low priority.**

### 1.5 PhysioNet: MIMIC-IV / MIMIC-IV-ED
- Free, with **credentialed access**: a PhysioNet account, CITI "Data or Specimens Only Research" training, and a signed DUA. Approval usually takes about 1–2 weeks **[U]**. https://physionet.org/content/mimiciv/
- Contains SCD encounters coded ICD-9 282.6x / ICD-10 D57.x (crisis codes D57.00–D57.819 distinguish ACS, splenic sequestration, etc.: https://aapc.com/codes/icd-10-codes/D57). The **number of SCD patients was not verified** **[U]**. A single Boston centre will likely yield a few hundred patients at most **[U]**.
- **Relevance:** ED triage vitals (HR, SpO2, temperature) **at presentation** with VOC, and in-hospital lab trajectories (Hb, LDH, WBC, retics) during the crisis. These help calibrate "during-crisis" signal shifts but **not the pre-crisis lead-up**. Note that ICD codes misclassify. A French validation found 18 of 25 D57-coded patients were true SCD (https://dovepress.com/validation-of-discharge-diagnosis-of-sickle-cell-disease-vaso-occlusiv-peer-reviewed-fulltext-article-CLEP) **[S]**.
- **First step:** get one team member credentialed now; it is the fastest real-data win.

### 1.6 UK National Haemoglobinopathy Register (NHR)
- About 12,660 registered SCD patients (NHR Annual Report 2019/20, via IthaMaps https://www.ithanet.eu/db/ithamaps?country=gb) **[S]**. Holds data only on consented patients. Managed by NHS Blood and Transplant: https://hospital.blood.co.uk/the-update/national-haemoglobinopathy-registry/
- **Access:** **no public research-request route was found**. Expect a formal application to NHSBT plus UK approvals (HRA/CAG) **[U]**. Contents: demographics, genotype, annual review data and acute episodes (variable completeness) **[U]**.
- **Recommendation:** medium priority; worth it only with a UK clinical partner.

### 1.7 SickleInAfrica / SPARCo / SADaCC (H3Africa successor), including Ghana
- Registry with **more than 40,000 patients** (Ghana, Mali, Nigeria, Tanzania, Uganda, Zambia, Zimbabwe) as of October 2025. It uses REDCap with harmonised data elements and the SCD Ontology, managed by SPARCo sites and **SADaCC** (Univ. Cape Town): https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12923167/ **[S]**.
- **Ghana site (Kumasi, KATH):** 3,148 patients enrolled from December 2017 to March 2020. 50.3% came from the newborn-screening cohort. Genotypes were SS 67.2%, SC 32.5%, Sβ+ 0.3% (Paintsil et al., Front Genet 2022, https://pmc.ncbi.nlm.nih.gov/articles/PMC8908904/) **[V]**.
- **Variables:** demographics, genotype, steady-state labs, hospitalisations, VOC, ACS, stroke and TCD (at some sites) **[S/U]**. Mostly clinic-visit granularity, not daily.
- **Access:** a governed consortium process run through SADaCC with an equity-of-use policy. **No open request form was found** **[S]**. Realistically this requires a **collaboration with KATH/KNUST (Kumasi) or Korle Bu SPARCo investigators** plus Ghana ethics approval.
- **Relevance: highest of all sources for Ghana-specific base rates.** H3Africa genomic data (EGA, controlled access via the H3Africa Data and Biospecimen Access Committee) is less relevant for VOC prediction **[U]**.
- **First step:** email the SPARCo-Ghana (KATH) team and SADaCC with a 1-page concept note proposing co-authorship and an analysis that runs in place.

### 1.8 Ghana cohorts
- **Kumasi newborn-screening cohort** (since 1995, KATH/Tikrom): 177,283 newborns screened by 2004 and more than 300,000 by 2009, with more than 5,000 SCD babies identified **[S]** (https://myprivateye.blogspot.com/2010/08/global-congress-on-sickle-cell-disease.html is a secondary source; primary: Ohene-Frempong et al., Pediatr Res 2005 abstract **[U]**). This is the longitudinal backbone of the KATH registry.
- **Korle Bu (Accra)** adult and paediatric clinics. Antwi-Boasiako 2018 (J Blood Med, doi:10.2147/JBM.S169872) reports steady-state vs crisis haematology for 208 SS and 82 SC patients in steady state and 156 SS and 34 SC patients in crisis **[S]**. Useful for Ghanaian lab distributions.
- **PIVOT trial** (hydroxyurea in HbSC, Ghana; n=214): baseline Hb 11.0 ± 1.2 g/dL, HbF 1.8 ± 1.5%, prior VOC 86% (Segbefia et al., BJH 2024, https://pubmed.ncbi.nlm.nih.gov/39406687/) **[V]**.
- **DHIMS-II national admissions** (2012–2017): 22,680 SCD admissions, median LOS 3 days (BMJ Open 2021;11:e048407, https://bmjopen.bmj.com/content/11/10/e048407) **[S]**. Aggregate data from GHS DHIMS2 could feed the regional dashboard (via GHS request) **[U]**.
- **Private insurer claims (Ghana, 2015–2021)**: cost of VOC (Marfo et al., BMC Health Serv Res 2023, https://bmchealthservres.biomedcentral.com/articles/10.1186/s12913-023-09984-6) **[S]**.

### 1.9 Wearable SCD studies (data sharing)
| Study | Device / n | Shared data? |
|---|---|---|
| Duke Day Hospital, Stojancic 2023, JMIR Form Res (https://pmc.ncbi.nlm.nih.gov/articles/PMC10131899/) | Apple Watch S3; adults admitted for VOC | Not public **[U]**. Ask the authors (Duke: Shah N., Tanabe P. **[U]**) |
| Duke inpatient→30 days post-discharge, Vuong 2023, Front Digit Health (https://pmc.ncbi.nlm.nih.gov/articles/PMC10634543/) | Apple Watch; n=19 (74% HbSS); 2,395 pain points | Not public **[U]** |
| USC (Coates/Khoo/Veluswamy) wristband PPG, Shah 2026 JMIR Hum Factors (PMID 41494152) | Biostrap; 12 SCD + 6 controls; 131 nights | Not public **[U]** |
| Amsterdam UMC Apple Watch study (https://onderzoekmetmensen.nl/en/trial/55175) | Apple Watch; ACS in inpatients / VOC in outpatients | Ongoing; results not found **[U]** |
| Fitbit / Empatica SCD studies | none with outcome data found in this search | n/a |

**Conclusion:** no shareable wearable+VOC dataset exists. The realistic path is a **data-sharing request to the Duke group** (small, but real) and SickleGuard's own prospective pilot.

---

## 2. Evidence that wearable / IoT signals change around VOC

| Signal | Evidence | Direction / size | Lead time | Limitations |
|---|---|---|---|---|
| **Heart rate (resting/average)** | Duke Apple Watch: resting HR was the 2nd most important feature for predicting pain score (random forest AUC 0.9 on a single split; **10-fold CV macro accuracy 62%**) **[V]** | Higher HR with higher pain. **No effect size reported** **[V]** | Concurrent (not pre-crisis) | n=19, single centre, mostly inpatient data, likely leakage between splits |
| **Steps / activity** | Duke: step count was the **top feature** **[V]** | Steps drop with pain (expected: near-zero when admitted) | Concurrent | Activity drop may be a *consequence* of pain, not a predictor |
| **HRV** | Duke: 4th most important feature **[V]**. 2023 ASH abstract (USC, Biostrap wristband): **lower high-frequency power (p=0.0002) and higher vasoconstriction magnitude (p=0.02) preceded higher next-day pain**; only 25 pain incidents (https://ash.confex.com/ash/2023/webprogram/Paper187353.html) **[S]**. Review: VOC associated with significant HRV decline (Mizrahi 2026, PMID 42644133) **[V, citing others]**. SCD has lower baseline HRV than controls (sympathetic predominance) **[V]** | Parasympathetic withdrawal (lower RMSSD/HF) before and during pain. Magnitude not reported | **~1 day** (USC pilot) | Pilot-level; PPG-derived HRV from wrist is noisy |
| **Peripheral vasoconstriction (PPG amplitude)** | Chalacheva 2021 AJH: nocturnal finger-PPG vasoconstriction **predicts frequency** of severe pain over follow-up **[S]**. Ji 2021 Front Digit Health: ML on sleep PPG flags elevated future risk **[S]** | More or stronger nocturnal vasoconstriction means higher risk | Trait-level (months); state-level lead about 1 day (pilot) | Lab polysomnography; wrist validation in progress |
| **SpO2 (incl. nocturnal)** | Hargrave 2003 Blood (n=95 children): **low mean nocturnal SpO2 strongly associated with higher painful-crisis rate (p<0.0001)** **[V]**. Steady-state SpO2 in SCA is lower: median 96% (IQR 94–97.4) vs 98% in controls; lower in adults (Jordan 2025 Neurology, PMC12614261) **[V]** | Low baseline (trait) means higher rate. Acute SpO2 drop **during ACS** (definition includes hypoxaemia) | Trait; acute drop is concurrent with ACS | Consumer pulse oximeters over-read in dark skin; SpO2 in SCD is affected by the dissociation curve shift |
| **Skin / body temperature** | Fever and infection are well-recognised precipitants; fever ≥38.5 °C triggers urgent evaluation (NHLBI 2014 guideline) **[U for quantification]** | Rise with infection or ACS. No VOC-specific wearable data found | 0–2 days **[U]** | Wrist skin temperature ≠ core temperature; ambient confounding |
| **Sleep** | Daily-diary studies (Valrie et al., children) suggest poor sleep → next-day pain **[U, citation from memory]**. Nocturnal hypoxaemia and vasoconstriction above | Shorter or poorer sleep → higher next-day pain | ~1 day | Self-report; bidirectional (pain → poor sleep) |
| **Daily self-reported pain** | PiSCES (Smith 2008, Ann Intern Med, n=232, 31,017 diary days): pain on **54.5% of days**, crisis days without utilisation **12.7%**, utilisation days only **3.5%**; 29.3% had pain on >95% of days **[V]** | Rising home pain and opioid use precede utilisation | Days | Key implication: **most crises never reach a hospital**. Choose the label definition carefully (see `sim_params.json`, `outcome_definition`) |

**Overall:** the evidence supports (a) **trait-level** risk markers (low nocturnal SpO2, vasoconstriction, low HRV) and (b) **concurrent** changes during pain (higher HR, fewer steps, lower HRV). Evidence for a **multi-day prodrome visible on consumer wearables is weak** (one pilot shows a 1-day lead). Ballas & Smith 1992 (Blood, 117 crises / 36 patients) document a **prodromal phase in which dense cells rise and RBC deformability falls 1–3 days before pain**, with Hb falling and reticulocytes rising early in the crisis **[V]**. This is the best physiological basis for a 1–3 day lead window.

---

## 3. Imaging, records and labs evidence

| Factor | Evidence | Use in model |
|---|---|---|
| **Prior ACS** (new infiltrate on CXR) | CSSCD (Castro 1994, Blood 84:643): 3,751 patients, 2,100 ACS events; incidence SS 12.8, Sβ0 9.4, SC 5.2, Sβ+ 3.9 per 100 pt-yrs; SS age 2–4: 25.3, adults 8.8. Higher steady-state Hb, lower HbF and higher WBC are associated with more ACS **[S]**. Prior ACS predicts early death (Platt 1994) **[V]** | History flag; raises ACS risk more than VOC risk **[U for VOC RR]** |
| **AVN** | Milner 1991 NEJM: prevalence 9.8% at entry (n=2,590); incidence per 100 pt-yrs: SS 2.4, SS+α-thal 4.5, Sβ0 3.6, Sβ+ 3.3, SC 1.9; **frequent pain is a risk factor** **[S]** | Chronic-pain confounder (raises daily pain without VOC); severity marker |
| **TCD (STOP thresholds)** | Time-averaged mean of maximum velocity in ICA/MCA: **<170 cm/s normal; 170–199 conditional; ≥200 abnormal** (STOP; Adams 1998 NEJM: transfusion → 92% lower stroke risk; standard care had 11 strokes among 67 children) **[V]**. Kumasi 2001: 13.2% of 136 children had elevated velocities **[S]**. Nigeria: conditional 10–19% **[S]** | Stroke-risk module; not a VOC predictor. Lower HRV is associated with higher TCD velocities (Ethn Dis 2014) **[S]** |
| **Silent cerebral infarcts (MRI)** | Cumulative in SCA: ~25% by 6 yrs, **39% by 18 yrs**, 53% by 30 yrs **[S]**. Adults: 45% SCI at median age 24; new infarct incidence 11.95 vs 3.74 /100 pt-yrs with vs without SCI (Jordan 2024 JAHA) **[V]** | Severity covariate; not a direct VOC predictor |
| **Splenomegaly** | Persists in HbSC and in African HbSS (Ghana PIVOT: palpable spleen in 6 children and 1 adult of 214) **[V]**. Acute splenic sequestration risk in young children **[U]** | Separate acute event type; Hb crash signal |
| **Hb vs baseline** | High Hct is associated with more pain (Platt 1991) **[V]**. Hb falls during VOC (Ballas 1992) **[V]**. Hb <7 g/dL before age 2 gives RR 2.47 for adverse outcome (Miller 2000) **[V]** | Trait (higher Hb → more pain in HbSS); state (Hb drop ≥1–2 g/dL from baseline → acute event / ACS / sequestration) |
| **HbF** | Low HbF is associated with more pain, ACS and early death (Platt 1991/1994, Castro 1994) **[V]**. HU raises HbF and cuts crises by ~44% (MSH) **[V]** | Strong protective covariate |
| **WBC** | Baseline WBC >15×10⁹/L is a mortality risk (Platt 1994) **[V]**. Leukocytosis without infection gives RR 1.80 for adverse outcome (Miller 2000) **[V]**. WBC rises during VOC and ACS **[U]** | Trait and state |
| **Reticulocytes, LDH, bilirubin** | Hemolysis markers; reticulocytes rise early in the crisis (Ballas 1992) **[V]**. LDH rises during VOC; high-LDH hemolytic phenotype linked to pulmonary HTN and leg ulcers more than to VOC (Kato 2006) **[U]** | State markers (rise of 20–40% during VOC **[U]**) |
| **CRP, ferritin** | CRP rises during VOC and ACS **[U]**. Ferritin is an acute-phase reactant, and iron overload is a marker of transfusion burden **[U]** | Infection / ACS discriminator |

---

## 4. Data strategy: simulated → real

1. **Phase 0, now (simulation):** use `sim_params.json`. Treat the **outcome definition** as a first-class decision: (a) healthcare-utilisation VOC (ED or admission, about 1–3/yr in severe adults), or (b) patient-reported crisis day (about 12.7% of days in PiSCES adults). The model and its metrics differ hugely between the two.
2. **Phase 1, within 0–3 months (public real data, free):**
   - Get **PhysioNet credentials** (MIMIC-IV/ED) to calibrate during-crisis vitals and labs.
   - Submit a **BioLINCC request for CSSCD + MSH** to calibrate base rates, lab effects and HU effect, and to externally sanity-check the simulator (compare simulated event distributions with real ones).
   - Map variables using the **CureSCi Metadata Catalog**. Start a dbGaP request for NHDR on BioData Catalyst if a US collaborator exists.
3. **Phase 2, within 3–12 months (Ghana partnership):**
   - Partner with **KATH Kumasi SCD centre (SPARCo-Ghana)** and/or **Korle Bu Centre for Clinical Genetics / Ghana Institute of Clinical Genetics**. Propose a retrospective registry analysis (federated or in place) plus a **prospective wearable pilot** (e.g. 60–100 patients × 6 months).
   - **Ethics:** institutional IRBs: KATH IRB / KNUST CHRPE (Kumasi); **Korle Bu Teaching Hospital IRB**; University of Ghana College of Health Sciences ERC (Accra); **Ghana Health Service ERC** (for studies at GHS facilities or multi-site community work); Noguchi (NMIMR) IRB. Ghana has **no national ethics committee** (https://journals.ug.edu.gh/index.php/hsij/article/download/2491/1774) **[S]**, so plan for each site's IRB. A device trial or medical-device claim may also need **Ghana FDA** involvement **[U]**. Fees and timelines are not published online **[U]**; budget about 2–4 months.
   - **Data protection:** the **Data Protection Act 2012 (Act 843)**. Data controllers **must register with the Data Protection Commission** before processing (s.53) and renew every 2 years **[S]** (https://dataprotection.org.gh/registration/, https://dataprotection.org.gh/compliance/). Health data are "special personal data" requiring explicit consent or a statutory basis **[S]**. Appoint a data-protection supervisor. If Azure stores data outside Ghana, address cross-border transfer in the consent and DPA filings **[U: Act 843 transfer specifics not verified]**.
   - **Consent:** tiered consent covering wearable streaming, EMR linkage, secondary use for model training, and data sharing with SADaCC. Use assent for minors.
4. **Interoperability:**
   - **EMR import via HL7 FHIR R4.** Resources: `Patient`, `Condition` (SNOMED/ICD-10 D57.x genotype and complication), `Observation` (LOINC labs: Hb 718-7, HbF 4576-5, WBC 6690-2, retic % 4679-7, LDH 2532-0, CRP 1988-5, ferritin 2276-4 **[U: verify LOINC codes]**), `Encounter` (ED/inpatient, for labels), `MedicationStatement` (hydroxyurea), `ImagingStudy`/`DiagnosticReport` (TCD, CXR, MRI). Many Ghanaian hospitals run **LHIMS** (MoH Lightwave HIMS) or DHIMS2 (aggregate). FHIR export capability is **unverified**, so plan for CSV/HL7v2 extracts as a fallback.
   - **Devices:** Apple **HealthKit** (on-device, via a companion iOS app), **Google Health Connect** (Android; most Ghanaian users are on Android **[U]**), **Fitbit Web API**, **Withings API** (BP, SpO2), Biostrap/Empatica research SDKs. Record device model and firmware, since pulse oximeters over-read SpO2 in darker skin.
5. **Sample size for the VOC model:**
   - Don't rely on "10 events per variable". Use **Riley et al. BMJ 2020;368:m441** (`pmsampsize`). Criteria: expected shrinkage ≥0.9, optimism in R² ≤0.05, and outcome risk estimated within ±0.05 **[S]**.
   - *Worked example (simulator assumption):* 7-day risk 2% (utilisation-defined VOC ≈ 1/yr), 20 candidate parameters, conservative R²_CS = 15% of max (0.027). This needs about **6,600 patient-weeks, about 130 events**. Because weeks cluster within patients, aim for **≥200 events from ≥150–200 distinct patients** and use mixed or patient-level CV.
   - **External validation:** at least **100, preferably ≥200 events** (Collins, Ogundimu & Altman, Stat Med 2016) **[U: from memory]**. Validate on a different site or period (e.g. develop on Kumasi, validate on Korle Bu).
   - Report per **TRIPOD+AI** and evaluate calibration (slope, CITL), not just AUC. Use temporal splits only. Present decision-curve analysis.
6. **Use of simulated data:** for pipeline building, feature engineering and power analysis only. **Never report simulated-data AUC as clinical performance.** Once real data arrive, use the simulator for pre-training or augmentation and test only on real data.

---

## Key references (verified abstracts)
- Platt OS et al. Pain in sickle cell disease: rates and risk factors. NEJM 1991;325:11–16. PMID 1710777.
- Charache S et al. Effect of hydroxyurea on the frequency of painful crises in sickle cell anemia. NEJM 1995;332:1317–22. PMID 7715639.
- Platt OS et al. Mortality in sickle cell disease. NEJM 1994;330:1639–44. PMID 7993409.
- Castro O et al. The acute chest syndrome in SCD: incidence and risk factors. Blood 1994;84:643–9 (search-summary only).
- Milner PF et al. Sickle cell disease as a cause of osteonecrosis of the femoral head. NEJM 1991;325:1476–81 (search-summary only).
- Adams RJ et al. STOP trial. NEJM 1998;339:5–11. PMID 9647873.
- Miller ST et al. Prediction of adverse outcomes in children with SCD. NEJM 2000;342:83–9. PMID 10631276.
- Ballas SK, Smith ED. RBC changes during the evolution of the sickle cell painful crisis. Blood 1992;79:2154–63. PMID 1562742.
- Smith WR et al. Daily assessment of pain in adults with SCD (PiSCES). Ann Intern Med 2008;148:94–101. PMID 18195334.
- Hargrave DR et al. Nocturnal oxygen saturation and painful sickle cell crises in children. Blood 2003;101:846–8. PMID 12393400.
- Vuong C et al. Use of consumer wearables to monitor and predict pain in SCD. Front Digit Health 2023. PMC10634543.
- Stojancic RS et al. Predicting pain … Apple Watch: feasibility study. JMIR Form Res 2023. PMC10131899.
- Shah P et al. Wearable device PPG … vasoconstriction biomarkers. JMIR Hum Factors 2026. PMID 41494152.
- Paintsil V et al. Establishing an SCD registry in Africa: SPARCO Kumasi. Front Genet 2022. PMC8908904.
- Segbefia CI et al. Baseline characteristics … PIVOT (HbSC, Ghana). BJH 2024. PMID 39406687.
- Jordan LC et al. Incidence and risk factors for new and recurrent infarcts in adults with SCD. JAHA 2024. PMC11255756.
- Jordan LC et al. Cerebral blood flow in children and adults with SCA. Neurology 2025. PMC12614261.
- Riley RD et al. Calculating the sample size required for developing a clinical prediction model. BMJ 2020;368:m441.
