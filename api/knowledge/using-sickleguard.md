# Using SickleGuard: Risk Scores and Care Team Responses

SickleGuard is a clinical decision-support demo that estimates the short-term risk of a vaso-occlusive crisis (VOC) for people with sickle cell disease (SCD). It combines daily patient check-ins with optional lab results to produce a 7-day risk score, and an AI assistant explains the score with citations from this knowledge base. This document explains how SickleGuard works, its limits, and how care teams should respond at each risk level.

## What SickleGuard collects in daily check-ins

In SickleGuard, patients with sickle cell disease complete a short daily check-in. The inputs are:

- **Pain score** (0–10)
- **Fluid intake** (litres per day)
- **Sleep** (hours)
- **Stress** (0–10)
- **Temperature** (°C)
- **Oxygen saturation** (SpO2, %) if a pulse oximeter is available
- **Cold exposure** (yes/no)
- **Infection symptoms** (e.g. sore throat, cough, urinary symptoms)
- **Chest symptoms** (chest pain, breathlessness)
- **Stroke-like symptoms** (weakness, facial droop, speech difficulty, severe headache, seizure)
- **Menstruation** (if applicable)
- **Alcohol** use
- **Strenuous activity**
- **Hydroxyurea taken** today (if prescribed)
- **Optional labs** such as haemoglobin, reticulocytes, LDH, WBC and HbF

These inputs reflect the triggers and risk markers described in the VOC overview and labs documents.

## How the SickleGuard risk score works

In SickleGuard, a machine-learning model combines recent check-ins (trends over several days, not just today) and any labs into a score representing the estimated risk of a VOC in the next 7 days. The score is grouped into four levels: **low**, **moderate**, **high** and **critical**. The assistant shows which factors contributed most — for example low fluid intake, poor sleep, rising pain, cold exposure, missed hydroxyurea or a falling haemoglobin — so that prevention advice can be targeted.

## Red flags always override the score

In SickleGuard, certain answers are treated as red flags regardless of the model's score. Fever of 38.5 °C or more (NHLBI; some local protocols use 38.0 °C), chest pain or breathing difficulty, SpO2 below 92 %, and stroke-like symptoms set the level to **critical** with the message to **seek emergency care**. Severe pain (8/10 or more) and a haemoglobin fall of 2 g/dL or more below baseline raise the level to at least **high** and ask for same-day contact or review. The model is never allowed to downgrade a red flag.

## Limits of SickleGuard

SickleGuard is decision support, not a diagnosis. Its model is trained on **synthetic data**, not real patient outcomes, and has not been clinically validated. Scores may be wrong for individual patients, may miss crises that have no warning signs, and depend on accurate self-reported data. It must not replace clinical judgement, local protocols or the patient's individualised care plan. Patients should always follow their care plan and seek help for any symptom that worries them, whatever the score says.

## Care team response by risk level

In SickleGuard, suggested responses for care teams are:

- **Low** – Continue routine care. Reinforce general prevention (hydration, warmth, sleep, adherence) at the next contact.
- **Moderate** – Review the contributing factors. Send prevention reminders tailored to the drivers (e.g. fluids, keeping warm, rest). Consider a check-in contact within a few days and watch the trend.
- **High** – Contact the patient within 24 hours. Review hydration, possible infection, sleep, stress and hydroxyurea adherence. Check the individualised care plan and ensure the patient knows their home pain plan and red flags. Consider whether labs or a clinic review are needed.
- **Critical** – Same-day contact. If a red flag is present, direct the patient to emergency care immediately (or call emergency services for stroke signs or severe breathing difficulty). Make sure the emergency team has access to the care plan.

## How the SickleGuard assistant uses this knowledge base

In SickleGuard, the AI assistant retrieves passages from these documents to explain risk factors and suggest prevention steps, and cites the document it used. It does not give medication doses; dosing is set by the haematology team. If asked about something not covered, it should say so and advise contacting the care team.

## Sources

- NHLBI. Evidence-Based Management of Sickle Cell Disease: Expert Panel Report, 2014.
- NICE. CG143: Sickle cell disease: managing acute painful episodes in hospital.
- ASH. 2020 guidelines for sickle cell disease: management of acute and chronic pain; cerebrovascular disease.
- CDC. Sickle Cell Disease: complications and prevention.

_For decision support in a demo system. Not a substitute for clinical judgement._
