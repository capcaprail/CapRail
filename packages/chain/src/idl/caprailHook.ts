// ЗГЕНЕРОВАНО `pnpm idl:sync` з target/types. Руками не редагувати.
//
// Тип — те, що згенерував `anchor build`; значення — той самий текст під
// анотацією цього типу. Анотація не декоративна: вона і є перевіркою, що
// вендорована копія не розійшлася з програмою — зайве поле чи інше ім'я не
// скомпілюється.
//
// Імена всередині лишаються такими, як їх пише Anchor: `Program` проганяє
// переданий IDL через власну конверсію в camelCase, тож форма запису тут на
// рантайм не впливає.

export type CaprailHook = {
  "address": "6EMZVfUkf2wrtwfnESLghWfdWyzDu71uJTJ7dCKG3YEi",
  "metadata": {
    "name": "caprailHook",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Transfer hook of CapRail tokens: the admission, vesting and ROFR rule, read-only over caprail state",
    "repository": "https://github.com/capcaprail/CapRail"
  },
  "instructions": [
    {
      "name": "execute",
      "discriminator": [
        105,
        37,
        101,
        197,
        75,
        251,
        102,
        26
      ],
      "accounts": [
        {
          "name": "source"
        },
        {
          "name": "mint",
          "relations": [
            "tokenConfig"
          ]
        },
        {
          "name": "destination"
        },
        {
          "name": "owner"
        },
        {
          "name": "extraAccountMetaList"
        },
        {
          "name": "stateProgram",
          "address": "As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g"
        },
        {
          "name": "tokenConfig"
        },
        {
          "name": "investorRecord"
        },
        {
          "name": "grant"
        },
        {
          "name": "transferPermit"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeExtraAccountMetaList",
      "discriminator": [
        92,
        197,
        174,
        197,
        41,
        124,
        19,
        3
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "extraAccountMetaList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "types": [
    {
      "name": "tokenConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "company",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "treasuryOwner",
            "type": "pubkey"
          },
          {
            "name": "policy",
            "type": {
              "defined": {
                "name": "transferPolicy"
              }
            }
          },
          {
            "name": "policyVersion",
            "type": "u32"
          },
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "totalSupply",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "transferPolicy",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "requireAccreditation",
            "type": "bool"
          },
          {
            "name": "requireRofr",
            "type": "bool"
          },
          {
            "name": "rofrWindowSecs",
            "type": "u32"
          }
        ]
      }
    }
  ]
}

export const IDL: CaprailHook = {
  "address": "6EMZVfUkf2wrtwfnESLghWfdWyzDu71uJTJ7dCKG3YEi",
  "metadata": {
    "name": "caprailHook",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Transfer hook of CapRail tokens: the admission, vesting and ROFR rule, read-only over caprail state",
    "repository": "https://github.com/capcaprail/CapRail"
  },
  "instructions": [
    {
      "name": "execute",
      "discriminator": [
        105,
        37,
        101,
        197,
        75,
        251,
        102,
        26
      ],
      "accounts": [
        {
          "name": "source"
        },
        {
          "name": "mint",
          "relations": [
            "tokenConfig"
          ]
        },
        {
          "name": "destination"
        },
        {
          "name": "owner"
        },
        {
          "name": "extraAccountMetaList"
        },
        {
          "name": "stateProgram",
          "address": "As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g"
        },
        {
          "name": "tokenConfig"
        },
        {
          "name": "investorRecord"
        },
        {
          "name": "grant"
        },
        {
          "name": "transferPermit"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeExtraAccountMetaList",
      "discriminator": [
        92,
        197,
        174,
        197,
        41,
        124,
        19,
        3
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "extraAccountMetaList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "types": [
    {
      "name": "tokenConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "company",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "treasuryOwner",
            "type": "pubkey"
          },
          {
            "name": "policy",
            "type": {
              "defined": {
                "name": "transferPolicy"
              }
            }
          },
          {
            "name": "policyVersion",
            "type": "u32"
          },
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "totalSupply",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "transferPolicy",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "requireAccreditation",
            "type": "bool"
          },
          {
            "name": "requireRofr",
            "type": "bool"
          },
          {
            "name": "rofrWindowSecs",
            "type": "u32"
          }
        ]
      }
    }
  ]
}
