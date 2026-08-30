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
  "instructions": [],
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
  "instructions": [],
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
    }
  ]
}
