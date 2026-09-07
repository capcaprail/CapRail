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

export type Caprail = {
  "address": "As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g",
  "metadata": {
    "name": "caprail",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Cap table on Solana: admission, vesting and ROFR enforced by the token itself (Token-2022 transfer hook)",
    "repository": "https://github.com/capcaprail/CapRail"
  },
  "instructions": [
    {
      "name": "createCompany",
      "discriminator": [
        36,
        192,
        217,
        147,
        233,
        129,
        198,
        18
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "company",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  112,
                  97,
                  110,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "args.companyId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createCompanyArgs"
            }
          }
        }
      ]
    },
    {
      "name": "createToken",
      "discriminator": [
        84,
        52,
        204,
        228,
        24,
        140,
        234,
        75
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "company"
          ]
        },
        {
          "name": "company",
          "writable": true
        },
        {
          "name": "mint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "company"
              },
              {
                "kind": "account",
                "path": "company.tokenCount",
                "account": "company"
              }
            ]
          }
        },
        {
          "name": "tokenConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110
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
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "company"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
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
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createTokenArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "company",
      "discriminator": [
        32,
        212,
        52,
        137,
        90,
        7,
        206,
        183
      ]
    },
    {
      "name": "tokenConfig",
      "discriminator": [
        92,
        73,
        255,
        43,
        107,
        51,
        117,
        101
      ]
    }
  ],
  "events": [
    {
      "name": "companyCreated",
      "discriminator": [
        183,
        208,
        141,
        81,
        6,
        83,
        112,
        99
      ]
    },
    {
      "name": "tokenCreated",
      "discriminator": [
        236,
        19,
        41,
        255,
        130,
        78,
        147,
        172
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notAccredited",
      "msg": "recipient is not an accredited investor of this company"
    },
    {
      "code": 6001,
      "name": "accreditationExpired",
      "msg": "recipient's accreditation has expired"
    },
    {
      "code": 6002,
      "name": "unvested",
      "msg": "amount exceeds the vested balance of the sender"
    },
    {
      "code": 6003,
      "name": "rofrWindowOpen",
      "msg": "transfer must go through an offer while the ROFR window is open"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "signer does not hold the role required by this instruction"
    },
    {
      "code": 6005,
      "name": "notTransferring",
      "msg": "hook must be invoked by the token program during a transfer"
    },
    {
      "code": 6006,
      "name": "tokenConfigMismatch",
      "msg": "token config does not belong to the transferred mint"
    },
    {
      "code": 6007,
      "name": "rofrNotSupported",
      "msg": "ROFR is not available in this version"
    },
    {
      "code": 6008,
      "name": "invalidRoles",
      "msg": "admin and compliance officer must be two different, non-zero keys"
    },
    {
      "code": 6009,
      "name": "invalidName",
      "msg": "name must be 1..=32 bytes of UTF-8"
    },
    {
      "code": 6010,
      "name": "invalidMetadata",
      "msg": "token symbol must be 1..=10 bytes and uri at most 200 bytes of UTF-8"
    },
    {
      "code": 6011,
      "name": "invalidSupply",
      "msg": "total supply must be positive and decimals at most 9"
    },
    {
      "code": 6012,
      "name": "invalidPolicy",
      "msg": "policy values are out of range"
    }
  ],
  "types": [
    {
      "name": "company",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "companyId",
            "type": "u64"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "complianceOfficer",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tokenCount",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "companyCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "company",
            "type": "pubkey"
          },
          {
            "name": "companyId",
            "type": "u64"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "complianceOfficer",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "createCompanyArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "companyId",
            "type": "u64"
          },
          {
            "name": "complianceOfficer",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "createTokenArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
          },
          {
            "name": "uri",
            "type": "string"
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
            "name": "policy",
            "type": {
              "defined": {
                "name": "transferPolicy"
              }
            }
          }
        ]
      }
    },
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
      "name": "tokenCreated",
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
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
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

export const IDL: Caprail = {
  "address": "As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g",
  "metadata": {
    "name": "caprail",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Cap table on Solana: admission, vesting and ROFR enforced by the token itself (Token-2022 transfer hook)",
    "repository": "https://github.com/capcaprail/CapRail"
  },
  "instructions": [
    {
      "name": "createCompany",
      "discriminator": [
        36,
        192,
        217,
        147,
        233,
        129,
        198,
        18
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "company",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  112,
                  97,
                  110,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "args.companyId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createCompanyArgs"
            }
          }
        }
      ]
    },
    {
      "name": "createToken",
      "discriminator": [
        84,
        52,
        204,
        228,
        24,
        140,
        234,
        75
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "company"
          ]
        },
        {
          "name": "company",
          "writable": true
        },
        {
          "name": "mint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "company"
              },
              {
                "kind": "account",
                "path": "company.tokenCount",
                "account": "company"
              }
            ]
          }
        },
        {
          "name": "tokenConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110
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
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "company"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
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
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createTokenArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "company",
      "discriminator": [
        32,
        212,
        52,
        137,
        90,
        7,
        206,
        183
      ]
    },
    {
      "name": "tokenConfig",
      "discriminator": [
        92,
        73,
        255,
        43,
        107,
        51,
        117,
        101
      ]
    }
  ],
  "events": [
    {
      "name": "companyCreated",
      "discriminator": [
        183,
        208,
        141,
        81,
        6,
        83,
        112,
        99
      ]
    },
    {
      "name": "tokenCreated",
      "discriminator": [
        236,
        19,
        41,
        255,
        130,
        78,
        147,
        172
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notAccredited",
      "msg": "recipient is not an accredited investor of this company"
    },
    {
      "code": 6001,
      "name": "accreditationExpired",
      "msg": "recipient's accreditation has expired"
    },
    {
      "code": 6002,
      "name": "unvested",
      "msg": "amount exceeds the vested balance of the sender"
    },
    {
      "code": 6003,
      "name": "rofrWindowOpen",
      "msg": "transfer must go through an offer while the ROFR window is open"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "signer does not hold the role required by this instruction"
    },
    {
      "code": 6005,
      "name": "notTransferring",
      "msg": "hook must be invoked by the token program during a transfer"
    },
    {
      "code": 6006,
      "name": "tokenConfigMismatch",
      "msg": "token config does not belong to the transferred mint"
    },
    {
      "code": 6007,
      "name": "rofrNotSupported",
      "msg": "ROFR is not available in this version"
    },
    {
      "code": 6008,
      "name": "invalidRoles",
      "msg": "admin and compliance officer must be two different, non-zero keys"
    },
    {
      "code": 6009,
      "name": "invalidName",
      "msg": "name must be 1..=32 bytes of UTF-8"
    },
    {
      "code": 6010,
      "name": "invalidMetadata",
      "msg": "token symbol must be 1..=10 bytes and uri at most 200 bytes of UTF-8"
    },
    {
      "code": 6011,
      "name": "invalidSupply",
      "msg": "total supply must be positive and decimals at most 9"
    },
    {
      "code": 6012,
      "name": "invalidPolicy",
      "msg": "policy values are out of range"
    }
  ],
  "types": [
    {
      "name": "company",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "companyId",
            "type": "u64"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "complianceOfficer",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tokenCount",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "companyCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "company",
            "type": "pubkey"
          },
          {
            "name": "companyId",
            "type": "u64"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "complianceOfficer",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "createCompanyArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "companyId",
            "type": "u64"
          },
          {
            "name": "complianceOfficer",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "createTokenArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
          },
          {
            "name": "uri",
            "type": "string"
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
            "name": "policy",
            "type": {
              "defined": {
                "name": "transferPolicy"
              }
            }
          }
        ]
      }
    },
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
      "name": "tokenCreated",
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
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
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
