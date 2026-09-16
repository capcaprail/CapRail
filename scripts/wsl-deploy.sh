#!/usr/bin/env bash
# Деплой обох програм на devnet із WSL — один раз і за гроші.
#
# Кликати з PowerShell, не з Git Bash (той переписує /mnt-шлях):
#   wsl.exe -e bash /mnt/<диск>/<шлях до репо>/scripts/wsl-deploy.sh <cost|deploy|verify> [caprail|caprail-hook]
#
#   cost     — розмір артефактів, рента за них, баланс гаманця, стан програм у мережі
#   deploy   — build-sbf → перевірки → `solana program deploy` (обидві або одна) → verify
#   verify   — зняти байткод із мережі і звірити з локальним .so байт у байт + e_flags
#
# Змінні оточення (усі необов'язкові):
#   CAPRAIL_DEPLOYER_KEYPAIR      гаманець, що платить і стає upgrade authority
#                                 (типово ~/.config/solana/id.json)
#   CAPRAIL_RPC_URL               вузол (типово публічний devnet; Helius — сюди, не на диск)
#   CAPRAIL_PROGRAM_KEYPAIR, CAPRAIL_HOOK_PROGRAM_KEYPAIR — як у wsl-build.sh
#
# # Чому спершу build-sbf, а не «що лежить у target/deploy»
#
# `anchor build` (команда `idl`) перезаписує ті самі .so артефактом SBPFv3, який
# Agave 3.1.10 не виконує. У мережу він зайшов би без помилки і впав би на першій
# інструкції. Тому деплой завжди починається зі свіжої v0-збірки і перевірки
# заголовка — а не з віри, що останнім запускали саме build-sbf.
#
# # Чому без --max-len
#
# `solana program deploy` без `--max-len` алокує programdata рівно на довжину
# програми (+45 байтів метаданих) — оцінка з подвійним буфером завищує ціну
# вдвічі. Оновлення того самого розміру доплати не потребує; більший розмір
# потребуватиме `solana program extend` — скрипт про це скаже, а не впаде мовчки.
#
# # Чому мейннет відкидається
#
# У цьому проекті немає жодної операції для мейннету без окремого рішення
# (.env.example). Гаманець деплою тут — той самий, що платить за девнет-демо,
# і одна помилка в URL не має коштувати справжніх грошей.

set -euo pipefail

export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/.deploy.log"
CMD="${1:-cost}"
ONLY="${2:-}"
RPC="${CAPRAIL_RPC_URL:-https://api.devnet.solana.com}"
DEPLOYER="${CAPRAIL_DEPLOYER_KEYPAIR:-$HOME/.config/solana/id.json}"
KEYS="${CAPRAIL_PROGRAM_KEYPAIR:-$HOME/.config/caprail/caprail-keypair.json}"
HOOK_KEYS="${CAPRAIL_HOOK_PROGRAM_KEYPAIR:-$HOME/.config/caprail/caprail-hook-keypair.json}"
# Ті самі адреси, що в declare_id! і Anchor.toml; збіг із ключами перевіряється нижче.
CAPRAIL_ID="As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g"
HOOK_ID="6EMZVfUkf2wrtwfnESLghWfdWyzDu71uJTJ7dCKG3YEi"
# Метадані programdata перед тілом програми (loader v3).
PROGRAMDATA_HEADER=45
LAMPORTS_PER_SOL=1000000000

cd "$ROOT"

case "$RPC" in
  *mainnet*)
    echo "ПОМИЛКА: $RPC схожий на мейннет — цей скрипт деплоїть тільки на devnet" >&2
    exit 2
    ;;
esac

# Ім'я програми → її .so, її ключ, її адреса.
so_of() { case "$1" in caprail) echo target/deploy/caprail.so ;; caprail-hook) echo target/deploy/caprail_hook.so ;; esac; }
key_of() { case "$1" in caprail) echo "$KEYS" ;; caprail-hook) echo "$HOOK_KEYS" ;; esac; }
id_of() { case "$1" in caprail) echo "$CAPRAIL_ID" ;; caprail-hook) echo "$HOOK_ID" ;; esac; }

case "$ONLY" in
  "") PROGRAMS=(caprail caprail-hook) ;;
  caprail | caprail-hook) PROGRAMS=("$ONLY") ;;
  *)
    echo "невідома програма: $ONLY (caprail | caprail-hook)" >&2
    exit 2
    ;;
esac

sol() { awk -v l="$1" -v s="$LAMPORTS_PER_SOL" 'BEGIN { printf "%.4f", l / s }'; }

# Рента, яку попросить деплой: programdata на довжину .so + метадані. Число з
# вузла, не з константи — параметри ренти живуть в мережі.
rent_lamports() {
  solana rent --url "$RPC" --lamports "$1" | awk '/Rent-exempt minimum/ {print $(NF-1)}'
}

e_flags() { readelf -h "$1" | awk '/Flags:/ {print $2}'; }

check_artifacts() {
  local program so flags
  for program in "${PROGRAMS[@]}"; do
    so="$(so_of "$program")"
    if [[ ! -f "$so" ]]; then
      echo "немає $so — спершу: scripts/wsl-build.sh build-sbf" >&2
      exit 1
    fi
    flags="$(e_flags "$so")"
    if [[ "$flags" != "0x0" ]]; then
      echo "ПОМИЛКА: $so має e_flags=$flags (не SBPFv0) — спершу: scripts/wsl-build.sh build-sbf" >&2
      exit 1
    fi
  done
}

check_keys() {
  local program key address
  if [[ ! -f "$DEPLOYER" ]]; then
    echo "немає гаманця деплою $DEPLOYER (CAPRAIL_DEPLOYER_KEYPAIR)" >&2
    exit 1
  fi
  for program in "${PROGRAMS[@]}"; do
    key="$(key_of "$program")"
    if [[ ! -f "$key" ]]; then
      echo "немає ключа програми $key" >&2
      exit 1
    fi
    address="$(solana address -k "$key")"
    if [[ "$address" != "$(id_of "$program")" ]]; then
      echo "ПОМИЛКА: ключ $program дає $address, а declare_id! — $(id_of "$program")" >&2
      exit 1
    fi
  done
}

# «Є в мережі» — з розміром programdata, щоб оновлення в більший розмір не
# впало посеред транзакцій на «account data too small».
deployed_len() {
  solana program show "$1" --url "$RPC" 2>/dev/null | awk '/Data Length:/ {print $3}' || true
}

balance_lamports() {
  solana balance "$(solana address -k "$DEPLOYER")" --url "$RPC" --lamports | awk '{print $1}'
}

do_cost() {
  local program so size data rent total=0 len
  echo "вузол:    $RPC"
  echo "гаманець: $(solana address -k "$DEPLOYER") — $(sol "$(balance_lamports)") SOL"
  echo
  for program in "${PROGRAMS[@]}"; do
    so="$(so_of "$program")"
    size="$(stat -c %s "$so")"
    data=$((size + PROGRAMDATA_HEADER))
    rent="$(rent_lamports "$data")"
    total=$((total + rent))
    len="$(deployed_len "$(id_of "$program")")"
    echo "$program: $so — $size байтів, e_flags $(e_flags "$so")"
    echo "  рента programdata ($data байтів): $(sol "$rent") SOL"
    if [[ -n "$len" ]]; then
      echo "  у мережі: $(id_of "$program"), programdata $len байтів$([[ "$len" -lt "$data" ]] && echo ' — МЕНШЕ за новий артефакт, потрібен extend')"
    else
      echo "  у мережі: немає"
    fi
  done
  echo
  echo "разом за перший деплой: $(sol "$total") SOL (+ комісії на запис буфера, частки SOL)"
}

do_verify() {
  local program so id dump size
  for program in "${PROGRAMS[@]}"; do
    so="$(so_of "$program")"
    id="$(id_of "$program")"
    dump="$(mktemp --suffix=.so)"
    solana program dump "$id" "$dump" --url "$RPC" >/dev/null
    size="$(stat -c %s "$so")"
    # Дамп може бути довшим за .so (буфер на оновлення); порівнюється рівно тіло програми.
    if ! cmp -s -n "$size" "$so" "$dump"; then
      echo "ПОМИЛКА: байткод $program у мережі відрізняється від $so" >&2
      rm -f "$dump"
      exit 1
    fi
    echo "OK — $program ($id): байт у байт як $so, e_flags у мережі $(e_flags "$dump")"
    rm -f "$dump"
  done
}

do_deploy() {
  local program so id data rent need=0 have len
  "$ROOT/scripts/wsl-build.sh" build-sbf
  check_artifacts
  check_keys

  for program in "${PROGRAMS[@]}"; do
    so="$(so_of "$program")"
    id="$(id_of "$program")"
    data=$(($(stat -c %s "$so") + PROGRAMDATA_HEADER))
    len="$(deployed_len "$id")"
    if [[ -z "$len" ]]; then
      need=$((need + $(rent_lamports "$data")))
    elif [[ "$len" -lt "$data" ]]; then
      echo "ПОМИЛКА: $program у мережі має programdata $len байтів, новий артефакт потребує $data —" >&2
      echo "  solana program extend $id $((data - len)) --url $RPC -k $DEPLOYER" >&2
      exit 1
    fi
  done
  have="$(balance_lamports)"
  echo "потрібно ≈ $(sol "$need") SOL ренти, на гаманці $(sol "$have") SOL"
  if [[ "$have" -lt $((need + LAMPORTS_PER_SOL / 20)) ]]; then
    echo "ПОМИЛКА: не вистачає SOL (з запасом 0,05 на комісії)" >&2
    exit 1
  fi

  : >"$LOG"
  for program in "${PROGRAMS[@]}"; do
    so="$(so_of "$program")"
    id="$(id_of "$program")"
    echo "── deploy $program → $id ──" | tee -a "$LOG"
    # Ключ програми потрібен лише першого разу (він створює адресу); далі та сама
    # команда робить оновлення під upgrade authority гаманця.
    if ! solana program deploy "$so" \
      --url "$RPC" \
      --keypair "$DEPLOYER" \
      --program-id "$(key_of "$program")" \
      --upgrade-authority "$DEPLOYER" \
      --commitment confirmed >>"$LOG" 2>&1; then
      echo "ПОМИЛКА: деплой $program впав — останні 30 рядків $LOG:"
      tail -30 "$LOG"
      echo "Буфер, якщо лишився, повертає SOL: solana program close --buffers --url $RPC -k $DEPLOYER"
      exit 1
    fi
    tail -3 "$LOG"
  done
  echo "лишилось на гаманці: $(sol "$(balance_lamports)") SOL"
  do_verify
}

echo "solana:  $(solana --version)"
echo

case "$CMD" in
  cost)
    check_artifacts
    do_cost
    ;;
  deploy)
    do_deploy
    ;;
  verify)
    check_artifacts
    do_verify
    ;;
  *)
    echo "невідома команда: $CMD (cost | deploy | verify)" >&2
    exit 2
    ;;
esac
