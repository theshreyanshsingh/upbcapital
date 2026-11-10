import assert from "node:assert/strict";
import test from "node:test";
import { subprocessors } from "../app/security/subprocessors";
import { prisma } from "../lib/prisma";
import { launchReadiness, type ReadinessItem } from "../lib/readiness";

// The public /security list and the desk's readiness panel say only what the code does with the configuration it
// runs with. Each env here is passed in whole, so the shared .env never decides a row.

test.after(async () => {
  await prisma.$disconnect();
});

const MODEL = { LLM_API_KEY: "sk-test-secret", AI_READING_MODEL: "1" };
const row = (items: ReadinessItem[], label: string) => items.find((item) => item.label === label)!;
const ai = (settings: { aiReading?: string | null }, env: Record<string, string>) => subprocessors({ stripePriceId: "", ...settings }, env).find((item) => item.category === "AI")!;

test("property values read live only with ATTOM and its key; without the key they are the stand-in, with the reason", async () => {
  const noKey = row((await launchReadiness({}, { AVM_PROVIDER: "attom" })).items, "Property values");
  assert.equal(noKey.state, "standin");
  assert.match(noKey.detail, /ATTOM_API_KEY isn't set/);
  assert.match(noKey.detail, /labelled mock/);
  assert.match(row((await launchReadiness({}, { AVM_PROVIDER: "attom", UPB_RELEASE: "1" })).items, "Property values").detail, /hidden from buyers/);
  const keyed = row((await launchReadiness({}, { AVM_PROVIDER: "attom", ATTOM_API_KEY: "attom-secret" })).items, "Property values");
  assert.equal(keyed.state, "live");
  assert.ok(!keyed.detail.includes("attom-secret"));
  assert.equal(row((await launchReadiness({}, {})).items, "Property values").state, "standin");
  // A name UPB has no provider for falls back to the stand-in too.
  const unknown = row((await launchReadiness({}, { AVM_PROVIDER: "zillow", ATTOM_API_KEY: "attom-secret" })).items, "Property values");
  assert.equal(unknown.state, "standin");
  assert.match(unknown.detail, /no provider named zillow/);
});

test("the document reader row says the desk's mode and whether the model is configured", async () => {
  const read = async (aiReading: string | null, env: Record<string, string>) => row((await launchReadiness({ aiReading }, env)).items, "Document reader");

  const off = await read("OFF", {});
  assert.equal(off.state, "off");
  assert.match(off.detail, /new files aren't read/);
  assert.match((await read("OFF", MODEL)).detail, /sends loan files to the model provider/);

  // Shadow is the default for settings saved before the switch existed.
  for (const mode of [null, "SHADOW"]) {
    const shadow = await read(mode, {});
    assert.equal(shadow.state, "standin");
    assert.match(shadow.detail, /^Shadow, with the offline rules/);
    assert.match(shadow.detail, /PDFs are skipped until the model is configured/);
  }
  const shadowModel = await read("SHADOW", MODEL);
  assert.equal(shadowModel.state, "standin");
  assert.match(shadowModel.detail, /loan files go to the model provider, and only the desk sees/);

  const onRules = await read("ON", {});
  assert.equal(onRules.state, "standin");
  assert.match(onRules.detail, /^On, with the offline rules/);
  assert.match(onRules.detail, /PDFs are skipped until the model is configured: set AI_READING_MODEL=1 and LLM_API_KEY/);
  const onModel = await read("ON", MODEL);
  assert.equal(onModel.state, "live");
  assert.match(onModel.detail, /sellers see its drafted answers/);

  // The flag without a key, or a key without the flag, is not the model path.
  assert.match((await read("ON", { AI_READING_MODEL: "1" })).detail, /AI_READING_MODEL is set but LLM_API_KEY isn't/);
  assert.equal((await read("ON", { LLM_API_KEY: "sk-test-secret" })).state, "standin");
  assert.ok(!onModel.detail.includes("sk-test-secret"));
});

test("the participations row says what waits on counsel, and that a sign-off belongs on file once it opens", async () => {
  const closed = row((await launchReadiness({}, {})).items, "Participations");
  assert.equal(closed.state, "off");
  assert.match(closed.detail, /Tranche groups, desk capital allocations, desk slices and partial relists wait on counsel/);
  const open = row((await launchReadiness({}, { UPB_PARTICIPATIONS: "1" })).items, "Participations");
  assert.equal(open.state, "live");
  assert.match(open.detail, /^Open/);
  assert.match(open.detail, /Counsel's sign-off should be on file/);
});

test("the sanctions row says when only the local stand-in list is used", async () => {
  const list = async (env: Record<string, string>) => row((await launchReadiness({}, env)).items, "Sanctions list");
  const mock = await list({});
  assert.equal(mock.state, "standin");
  assert.match(mock.detail, /Only the local stand-in list/);
  // An address that doesn't name SDN.CSV can't load the aliases, so screening uses the stand-in.
  const wrong = await list({ OFAC_SDN_URL: "https://example.gov/sdn.xml" });
  assert.equal(wrong.state, "standin");
  assert.match(wrong.detail, /only the local stand-in list is used/);
  assert.equal((await list({ OFAC_SDN_URL: "https://example.gov/SDN.CSV" })).state, "live");
  assert.equal((await list({ OFAC_API_URL: "https://vendor.example/list", OFAC_API_KEY: "ofac-secret" })).state, "live");
  const sanctions = (env: Record<string, string>) => subprocessors({ stripePriceId: "" }, env).find((item) => item.category === "Sanctions list")!;
  assert.equal(sanctions({ OFAC_SDN_URL: "https://example.gov/sdn.xml" }).inUse, false);
  assert.equal(sanctions({ OFAC_SDN_URL: "https://example.gov/SDN.CSV" }).name, "US Treasury SDN list");
});

test("the AI row says whether loan files reach a model provider, and who sees what it reads", () => {
  // No key: nothing goes to a model.
  const none = ai({ aiReading: "ON" }, {});
  assert.equal(none.inUse, false);
  assert.match(none.detail, /no loan file leaves UPB for an AI provider/);

  // A key for the desk assistant alone keeps loan files on UPB's servers, in any reader mode.
  for (const aiReading of ["OFF", "SHADOW", "ON", null]) {
    const desk = ai({ aiReading }, { LLM_API_KEY: "sk-test-secret" });
    assert.equal(desk.inUse, true);
    assert.equal(desk.name, "OpenAI");
    assert.match(desk.detail, /Buyers and sellers never use it, and no loan file leaves UPB for it: the document reader runs without a model/);
  }

  // The model configured with the reader off sends no file either.
  assert.match(ai({ aiReading: "OFF" }, MODEL).detail, /no loan file leaves UPB for it: the document reader is off/);

  // Shadow: loan files go to the provider; only the desk sees what comes back.
  for (const aiReading of ["SHADOW", null]) {
    const shadow = ai({ aiReading }, MODEL);
    assert.equal(shadow.inUse, true);
    assert.match(shadow.detail, /sends it loan files and data-room documents/);
    assert.match(shadow.detail, /borrowers' names and addresses/);
    assert.match(shadow.detail, /goes only to the desk/);
    assert.doesNotMatch(shadow.detail, /never use it|sellers/);
  }

  // On: sellers see what it reads too, and the desk still confirms each reading.
  const on = ai({ aiReading: "ON" }, MODEL);
  assert.match(on.detail, /sends it loan files/);
  assert.match(on.detail, /sellers and brokers see its drafted answers/);
  assert.match(on.detail, /only once the desk confirms the reading/);
  assert.doesNotMatch(on.detail, /never use it|only to the desk/);

  for (const item of [none, on]) assert.ok(!JSON.stringify(item).includes("sk-test-secret"));
});

test("the AI provider is named from its host, never with a key, a path or a private address", () => {
  const name = (base: string) => ai({ aiReading: "SHADOW" }, { ...MODEL, LLM_BASE_URL: base }).name;
  assert.equal(name("https://openrouter.ai/api/v1"), "OpenRouter");
  assert.equal(name("https://api.openai.com/v1"), "OpenAI");
  assert.equal(name("https://upb.openai.azure.com/openai/deployments/reader"), "Microsoft Azure OpenAI");
  assert.equal(name("https://user:pw@llm.example.com/secret-path/v1"), "The model provider at llm.example.com");
  assert.equal(name("http://10.0.0.5:8000/v1"), "A model server at a private or numeric address");
  assert.equal(name("http://model.internal/v1"), "A model server at a private or numeric address");
  assert.equal(name("not a url"), "A language model provider");
});

test("the hosting and database rows come from config: the host is named or said to be unnamed, and no address shows", () => {
  const find = (env: Record<string, string>, category: string) => subprocessors({ stripePriceId: "" }, env).find((item) => item.category === category)!;
  assert.equal(find({ VERCEL: "1", HOSTING_PROVIDER: "Other host" }, "Hosting").name, "Vercel");
  const named = find({ HOSTING_PROVIDER: "  Amazon   Web Services " }, "Hosting");
  assert.equal(named.inUse, true);
  assert.equal(named.name, "Amazon Web Services");
  const unnamed = find({}, "Hosting");
  assert.equal(unnamed.name, "Not named");
  assert.match(unnamed.detail, /doesn't name yet \(HOSTING_PROVIDER\)/);

  const atlasUrl = "mongodb+srv://upb-user:p@ss-secret@cluster0.abc12.mongodb.net/upb_capital?retryWrites=true";
  const atlas = find({ DATABASE_URL: atlasUrl }, "Database");
  assert.equal(atlas.name, "MongoDB Atlas");
  assert.equal(atlas.inUse, true);
  assert.match(atlas.detail, /borrowers' names/);
  const local = find({ DATABASE_URL: "mongodb://localhost:27017/upb_capital?directConnection=true" }, "Database");
  assert.equal(local.inUse, false);
  assert.match(local.detail, /application's own server/);
  const other = find({ DATABASE_URL: "mongodb://upb:secret@db1.example.net:27017,db2.example.net:27017/upb_capital" }, "Database");
  assert.equal(other.name, "A MongoDB server");
  const text = JSON.stringify(subprocessors({ stripePriceId: "" }, { DATABASE_URL: atlasUrl, BLOB_READ_WRITE_TOKEN: "blob-secret" }));
  for (const secret of ["upb-user", "p@ss-secret", "cluster0", "abc12", "blob-secret"]) assert.ok(!text.includes(secret), secret);
  assert.equal(find({ BLOB_READ_WRITE_TOKEN: "blob-secret" }, "File storage").name, "Vercel Blob");
  assert.equal(find({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }, "File storage").name, "Amazon S3");
});
