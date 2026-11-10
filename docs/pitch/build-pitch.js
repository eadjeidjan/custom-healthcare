const pptxgen = require("pptxgenjs");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const sharp = require("sharp");
const fa = require("react-icons/fa");
const { applyTheme } = require("./apply_theme.js");

const THEME = {
  name: "SickleGuard", headFontFace: "Calibri", bodyFontFace: "Calibri",
  colors: { dk1: "0B1226", lt1: "FFFFFF", dk2: "141D38", lt2: "CBD5E1",
            accent1: "E23D5A", accent2: "2DD4BF", accent3: "F59E0B", accent4: "94A3B8",
            accent5: "26345C", accent6: "60A5FA", hlink: "2DD4BF", folHlink: "94A3B8" },
};
const HEX = THEME.colors;

async function icon(name, color, bg) {
  const svg = renderToStaticMarkup(React.createElement(fa[name], { color: "#" + color, size: 256 }));
  const fg = await sharp(Buffer.from(svg)).resize(150, 150).png().toBuffer();
  const circle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="128" r="128" fill="#${bg}"/></svg>`);
  const out = await sharp(circle).composite([{ input: fg, top: 53, left: 53 }]).png().toBuffer();
  return "image/png;base64," + out.toString("base64");
}

(async () => {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";            // 13.333 x 7.5 in
  pres.title = "SickleGuard pitch";
  pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
  const C = pres.SchemeColor;

  pres.defineSlideMaster({
    title: "Pitch one-pager",
    background: { color: C.text1 },
    objects: [
      { placeholder: { options: { name: "title", type: "title", x: 0.55, y: 1.05, w: 12.2, h: 0.75, fontSize: 36, bold: true,
          color: C.background1, valign: "top", align: "left", margin: 0 }, text: "" } },
      { placeholder: { options: { name: "body", type: "body", x: 0.55, y: 1.85, w: 11.5, h: 0.6, fontSize: 16,
          color: C.background2, valign: "top", margin: 0 }, text: "" } },
    ],
  });

  pres.addSection({ title: "Pitch" });
  const s = pres.addSlide({ masterName: "Pitch one-pager", sectionTitle: "Pitch" });

  // Header: logo, name, URL
  s.addImage({ data: await icon("FaHeartbeat", HEX.lt1, HEX.accent1), x: 0.55, y: 0.38, w: 0.48, h: 0.48, objectName: "Logo" });
  s.addText([{ text: "SICKLE", options: { color: C.background1 } }, { text: "GUARD", options: { color: C.accent1 } }],
    { x: 1.15, y: 0.36, w: 4, h: 0.3, fontSize: 16, bold: true, charSpacing: 3, margin: 0, isTextBox: true, objectName: "Brand" });
  s.addText("VOC early warning for sickle cell disease", { x: 1.15, y: 0.64, w: 5, h: 0.25, fontSize: 11, color: C.accent4, margin: 0, isTextBox: true, objectName: "Tagline" });
  s.addText("sickleguard.kasadaai.com", { x: 8.3, y: 0.45, w: 4.45, h: 0.3, fontSize: 13, color: C.accent2, bold: true, align: "right", margin: 0, isTextBox: true, objectName: "URL" });

  s.addText("See a sickle cell crisis coming, days before it arrives", { placeholder: "title" });
  s.addText("SickleGuard predicts each patient's 7-day risk of a vaso-occlusive crisis (VOC), shows why, and tells the right person what to do.",
    { placeholder: "body" });

  // Three cards
  const cards = [
    { icon: "FaExclamationTriangle", tint: HEX.accent1, head: "The problem", items: [
      "Pain crises (VOC) are the main reason people with sickle cell disease go to hospital",
      "Ghana: an estimated 5,000–15,000+ babies are born with SCD every year",
      "Most crises build up at home, unseen until the pain hits" ] },
    { icon: "FaBrain", tint: HEX.accent2, head: "How it works", items: [
      "Combines wearables, oximeters, labs, imaging (x-ray, MRI, TCD) and daily check-ins",
      "7-day risk score with its reasons",
      "AI prevention plan grounded in guidelines",
      "Red flags override: emergency care first" ] },
    { icon: "FaUsers", tint: HEX.accent3, head: "Three views", items: [
      "Care providers: watchlist, alerts, AI assistant",
      "Patients: 60-second check-in, risk in plain words, emergency button",
      "Policy makers: regional map, forecasts, what-if scenarios (anonymised)" ] },
  ];
  const cw = (13.333 - 1.1 - 0.6) / 3, cy = 2.5, ch = 3.05;
  for (let i = 0; i < 3; i++) {
    const c = cards[i], x = 0.55 + i * (cw + 0.3);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: cy, w: cw, h: ch, rectRadius: 0.12, fill: { color: C.text2 },
      line: { color: C.accent5, width: 1 }, objectName: `Card ${i + 1}` });
    s.addImage({ data: await icon(c.icon, HEX.dk1, c.tint), x: x + 0.3, y: cy + 0.28, w: 0.46, h: 0.46, objectName: `Card ${i + 1} icon` });
    s.addText(c.head, { x: x + 0.9, y: cy + 0.3, w: cw - 1.1, h: 0.42, fontSize: 20, bold: true, color: C.background1, valign: "middle", margin: 0, isTextBox: true, objectName: `Card ${i + 1} heading` });
    s.addText(c.items.map((t, k) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: k < c.items.length - 1, paraSpaceAfter: 5 } })),
      { x: x + 0.3, y: cy + 0.9, w: cw - 0.55, h: ch - 1.05, fontSize: 14, color: C.background2, valign: "top", margin: 0, isTextBox: true, objectName: `Card ${i + 1} text` });
  }

  // Stat callouts
  const stats = [
    { n: "7 days", l: "early-warning horizon", col: C.accent2 },
    { n: "−44%", l: "crises on hydroxyurea¹; we track adherence", col: C.accent2 },
    { n: "4", l: "data streams fused per patient", col: C.background1 },
    { n: "3", l: "interfaces, one shared record", col: C.background1 },
  ];
  const sy = 5.85, sw = 2.0;
  stats.forEach((st, i) => {
    const x = 0.55 + i * (sw + 0.07);
    s.addText(st.n, { x, y: sy, w: sw, h: 0.55, fontSize: 32, bold: true, color: st.col, margin: 0, isTextBox: true, objectName: `Stat ${i + 1} value` });
    s.addText(st.l, { x, y: sy + 0.56, w: sw - 0.15, h: 0.5, fontSize: 11, color: C.accent4, valign: "top", margin: 0, isTextBox: true, objectName: `Stat ${i + 1} label` });
  });

  // The ask
  const ax = 0.55 + 2 * (cw + 0.3);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: ax, y: 5.8, w: cw, h: 1.15, rectRadius: 0.12, fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 }, objectName: "Ask card" });
  s.addText([{ text: "The ask", options: { bold: true, fontSize: 16, breakLine: true } },
             { text: "6-month pilot with a Ghana sickle cell clinic: 200 patients, real outcomes to validate the model", options: { fontSize: 13 } }],
    { x: ax + 0.25, y: 5.88, w: cw - 0.5, h: 1.0, color: C.background1, valign: "middle", margin: 0, isTextBox: true, objectName: "Ask text" });

  s.addText("OpenAI · LangGraph · LangChain · MCP · RAG · Qdrant   |   ¹ Multicenter Study of Hydroxyurea: 2.5 vs 4.5 crises/yr   |   Decision support only; model trained on synthetic data until the pilot",
    { x: 0.55, y: 7.02, w: 12.2, h: 0.3, fontSize: 10, color: C.accent4, margin: 0, isTextBox: true, objectName: "Footnote" });

  s.addNotes("Every year thousands of babies in Ghana are born with sickle cell disease, and painful vaso-occlusive crises are the main reason they end up in hospital. Most crises build for days at home before anyone sees them. SickleGuard brings together wearable and pulse-oximeter data, lab results, imaging and a one-minute daily check-in to predict each patient's 7-day crisis risk, explain the drivers, and suggest prevention steps grounded in guidelines. Emergency signs always override the model. Care teams get a watchlist and alerts, patients get a simple phone app with an emergency button, and policy makers get anonymised regional trends, forecasts and what-if scenarios such as widening hydroxyurea coverage. Our ask: a six-month pilot with a Ghana sickle cell clinic to validate the model on real outcomes.");

  await pres.writeFile({ fileName: "SickleGuard-pitch.pptx" });
  await applyTheme("SickleGuard-pitch.pptx", THEME);
  console.log("written");
})();
