import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { Credential } from "../src/credential"
import { Model } from "../src/model"
import { Pentest } from "../src/pentest"
import { Provider } from "../src/provider"
import { Workbench } from "../src/workbench"

const pentestAdmission = (overrides: Record<string, unknown> = {}) => ({
  label: "Juice Shop",
  baseURL: "https://app.test",
  mode: "blackbox",
  inScopeLines: "https://app.test/",
  outOfScopeLines: "",
  network: "allowlist",
  wallSecondsMax: 3_600,
  modelTokensMax: 100_000,
  modelCostUsdMax: 5,
  requestLimit: 200,
  authorizationNote: "Authorized lab target",
  recordedAt: 1_800_000_000_000,
  ...overrides,
})

describe("Workbench admission contracts", () => {
  test("keeps canonical budget schemas identical to the public contracts", () => {
    expect(Workbench.PentestBudget).toBe(Pentest.TargetContract.fields.budgets)
  })

  test("converts provider/model text and preserves the selection boundary", () => {
    const model = Workbench.modelRefFromString("local/model/name")
    expect(model).toEqual(Model.Ref.make({ id: Model.ID.make("model/name"), providerID: Provider.ID.make("local") }))
    expect(Workbench.encodeModelRef(model!)).toBe("local/model/name")
    expect(Schema.decodeUnknownSync(Workbench.ModelRefFromString)("local/model")).toEqual(
      Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("local") }),
    )
    expect(Schema.encodeSync(Workbench.ModelRefFromString)(model!)).toBe("local/model/name")
    expect(Option.isNone(Schema.decodeUnknownOption(Workbench.ModelRefText)("missing-separator"))).toBe(true)

    const selection = Workbench.modelProfileSelectionOf({
      modelRef: "local/model",
      profileID: "profile-1",
      profileRevision: 3,
      variant: "high",
    })
    expect(selection).toMatchObject({
      model: { providerID: "local", id: "model", variant: "high" },
      profileID: "profile-1",
      profileRevision: 3,
    })
    expect(Workbench.encodeModelProfileSelection(selection)).toEqual({
      modelRef: "local/model",
      profileID: "profile-1",
      profileRevision: 3,
      variant: "high",
    })
  })

  test("trims line-oriented scope and builds a bounded pentest target", () => {
    const scope = Schema.decodeUnknownSync(Workbench.ScopeFromLines)({
      inScopeLines: " https://app.test/ \n\n https://api.test/ ",
      outOfScopeLines: " https://app.test/admin \n",
    })
    expect(scope).toEqual({
      inScope: ["https://app.test/", "https://api.test/"],
      outOfScope: ["https://app.test/admin"],
    })
    expect(Schema.encodeSync(Workbench.ScopeFromLines)(scope)).toEqual({
      inScopeLines: "https://app.test/\nhttps://api.test/",
      outOfScopeLines: "https://app.test/admin",
    })
    expect(
      Option.isNone(
        Workbench.decodeScopeLines({
          inScopeLines: Array.from({ length: 201 }, (_, index) => `https://scope-${index}.test`).join("\n"),
          outOfScopeLines: "",
        }),
      ),
    ).toBe(true)

    const target = Workbench.buildPentestTargetFromAdmission({
      label: " Juice Shop ",
      baseURL: " http://127.0.0.1:3000 ",
      mode: "blackbox",
      sourceDir: "",
      authProfiles: [
        {
          id: "admin",
          label: "Administrator",
          credentialID: Credential.ID.make("cred_target_admin"),
          type: "bearer",
        },
      ],
      inScopeLines: " http://127.0.0.1:3000/ ",
      outOfScopeLines: "",
      network: "allowlist",
      wallSecondsMax: 3_600,
      modelTokensMax: 100_000,
      modelCostUsdMax: 5,
      requestLimit: 200,
      authorizationNote: " Lab target ",
      recordedAt: 1_800_000_000_000,
    })

    expect(target).toEqual({
      label: "Juice Shop",
      baseURL: "http://127.0.0.1:3000",
      mode: "blackbox",
      sourceDir: undefined,
      authProfiles: [
        {
          id: "admin",
          label: "Administrator",
          credentialID: Credential.ID.make("cred_target_admin"),
          type: "bearer",
        },
      ],
      inScope: ["http://127.0.0.1:3000/"],
      outOfScope: [],
      networkPolicy: "allowlist",
      budgets: {
        wallSecondsMax: 3_600,
        modelTokensMax: 100_000,
        modelCostUsdMax: 5,
        requestLimit: 200,
      },
      authorization: { note: "Lab target", recordedAt: 1_800_000_000_000 },
    })
  })

  test("keeps model-facing credential and admission fields simple", () => {
    expect(Object.keys(Workbench.ToolPentestAuthProfile.fields)).toEqual([
      "id",
      "label",
      "credential_id",
      "type",
      "header_name",
    ])
    expect(Object.keys(Workbench.ToolPentestAdmissionInput.fields)).toEqual([
      "label",
      "base_url",
      "mode",
      "source_dir",
      "auth_profiles",
      "in_scope",
      "out_of_scope",
      "authorization_note",
      "network_policy",
      "name",
    ])
  })

  test("preserves auth profile credential references through origin-bound target admission", () => {
    expect(
      Workbench.pentestTargetFromToolInput({
        label: "Juice Shop",
        base_url: "https://app.test",
        mode: "blackbox",
        auth_profiles: [
          {
            id: "admin",
            label: "Administrator",
            credential_id: Credential.ID.make("cred_target_admin"),
            type: "bearer",
          },
        ],
        in_scope: ["/api"],
        authorization_note: "Authorized lab target",
        network_policy: "allowlist",
      }).authProfiles,
    ).toEqual([
      {
        id: "admin",
        label: "Administrator",
        credentialID: Credential.ID.make("cred_target_admin"),
        type: "bearer",
      },
    ])
  })

  test("fails closed on malformed URLs, credentials, invalid schemes, and unsupported relatives", () => {
    const invalid = [
      { baseURL: "http://[::1" },
      { baseURL: "https://%" },
      { baseURL: "/target" },
      { inScopeLines: "https://[::1" },
      { inScopeLines: "https://app..test/" },
      { outOfScopeLines: "https://app.test/%zz" },
      { baseURL: "https://user:secret@app.test" },
      { baseURL: "https://@app.test" },
      { inScopeLines: "https://user:secret@app.test/admin" },
      { inScopeLines: "ftp://app.test/" },
      { inScopeLines: "admin" },
      { outOfScopeLines: "./admin" },
    ]

    for (const override of invalid) {
      expect(() => Workbench.decodePentestAdmission(pentestAdmission(override))).not.toThrow()
      expect(Option.isNone(Workbench.decodePentestAdmission(pentestAdmission(override)))).toBe(true)
    }
  })

  test("resolves root-relative rules against the canonical base origin", () => {
    const admission = Workbench.decodePentestAdmission(
      pentestAdmission({
        baseURL: "HTTPS://APP.TEST:443/app/../shop",
        inScopeLines: "/admin\nhttps://API.TEST:443/v1/../v2",
        outOfScopeLines: "/admin/private",
      }),
    )

    expect(Option.isSome(admission)).toBe(true)
    if (Option.isNone(admission)) return
    expect(admission.value.baseURL).toBe("https://app.test/shop")
    expect(admission.value.inScopeLines).toBe("https://app.test/admin\nhttps://api.test/v2")
    expect(admission.value.outOfScopeLines).toBe("https://app.test/admin/private")
    expect(Workbench.buildPentestTargetFromAdmission(admission.value)).toMatchObject({
      baseURL: "https://app.test/shop",
      inScope: ["https://app.test/admin", "https://api.test/v2"],
      outOfScope: ["https://app.test/admin/private"],
    })
  })

  test("canonicalizes encoded paths, default ports, and dot segments", () => {
    const admission = Workbench.decodePentestAdmission(
      pentestAdmission({
        baseURL: "https://APP.TEST:443/a/../%7Eshop",
        inScopeLines: "https://APP.TEST:443/api%2Fv1/%2E%2E/%7eusers/%E2%9C%93/%252F",
        outOfScopeLines: "/%61dmin/./private",
      }),
    )

    expect(Option.isSome(admission)).toBe(true)
    if (Option.isNone(admission)) return
    expect(admission.value.baseURL).toBe("https://app.test/~shop")
    expect(admission.value.inScopeLines).toBe("https://app.test/~users/%E2%9C%93/%252F")
    expect(admission.value.outOfScopeLines).toBe("https://app.test/admin/private")
  })

  test("canonicalizes model-facing tool targets before contract creation", () => {
    const target = Workbench.pentestTargetFromToolInput({
      label: "Juice Shop",
      base_url: "HTTPS://APP.TEST:443/a/../shop",
      mode: "blackbox",
      in_scope: ["/admin"],
      out_of_scope: ["/%61dmin/private"],
      authorization_note: "Authorized lab target",
      network_policy: "allowlist",
    })

    expect(target).toMatchObject({
      baseURL: "https://app.test/shop",
      inScope: ["https://app.test/admin"],
      outOfScope: ["https://app.test/admin/private"],
    })
  })

  test("requires non-empty valid in-scope and gives direct builders a bounded error", () => {
    expect(Option.isNone(Workbench.decodePentestAdmission(pentestAdmission({ inScopeLines: "\n  \n" })))).toBe(true)
    expect(() => Workbench.pentestTargetFromAdmission(pentestAdmission({ outOfScopeLines: "not-a-url" }))).toThrow(
      "Invalid pentest target admission",
    )
    expect(() =>
      Workbench.targetOf({
        label: "Juice Shop",
        baseURL: "file:///tmp/target",
        mode: "blackbox",
        inScope: ["https://app.test"],
        authorizationNote: "Authorized lab target",
        networkPolicy: "allowlist",
      }),
    ).toThrow("Invalid pentest target admission")
    expect(() =>
      Workbench.pentestTargetFromToolInput({
        label: "Juice Shop",
        base_url: "https://app.test",
        mode: "blackbox",
        in_scope: ["https://app.test", " "],
        authorization_note: "Authorized lab target",
        network_policy: "allowlist",
      }),
    ).toThrow("Invalid pentest target admission")
  })
})
