#!/usr/bin/env bash
# Збірка ончейн-частини у WSL з репозиторію, що лежить на Windows-диску.
#
# Кликати з PowerShell, не з Git Bash:
#   wsl.exe -e bash /mnt/<диск>/<шлях до репо>/scripts/wsl-build.sh <команда>
#
# Три речі тут не косметичні:
#
# 1. Git Bash переписує аргумент виду /mnt/<диск>/... у Windows-шлях ще до того,
#    як його побачить wsl. Тому виклик іде з PowerShell.
# 2. Скрипт передається ФАЙЛОМ, а не рядком через `bash -c`: лапки й долари
#    у рядку проходять через два шари інтерпретації і тихо міняють сенс.
# 3. PATH прописаний тут явно. Неінтерактивний shell не читає ~/.profile,
#    тож cargo-build-sbf і anchor інакше просто не знаходяться.

set -euo pipefail

export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/.build.log"
CMD="${1:-build-sbf}"
# Дві програми: `caprail` (стан і дії) і `caprail-hook` (правило). Хук окремий,
# бо програма-хук не може сама переказувати свій мінт (реентерабельність).
PROGRAMS=(caprail caprail-hook)
SO="target/deploy/caprail.so"
HOOK_SO="target/deploy/caprail_hook.so"
# Ключі програм — поза репозиторієм: за замовчуванням у домашній теці WSL,
# інше місце — через змінні оточення.
KEYS="${CAPRAIL_PROGRAM_KEYPAIR:-$HOME/.config/caprail/caprail-keypair.json}"
HOOK_KEYS="${CAPRAIL_HOOK_PROGRAM_KEYPAIR:-$HOME/.config/caprail/caprail-hook-keypair.json}"

cd "$ROOT"

# Увесь вивід іде у файл ЗСЕРЕДИНИ скрипта.
#
# Якщо перенаправляти зовні, прогрес-бар cargo перезаписує рядок кареткою, і
# у файлі не лишається причини падіння — тільки останній кадр прогресу. Далі
# читаємо файл і показуємо хвіст.
run() {
  echo "── $* ──" >>"$LOG"
  if ! "$@" >>"$LOG" 2>&1; then
    echo "ПОМИЛКА: $*"
    echo "── останні 40 рядків $LOG ──"
    tail -40 "$LOG"
    exit 1
  fi
}

# Ключ програми живе поза репозиторієм (він дає право деплою під той самий
# адрес). `anchor build` без нього згенерував би новий і мовчки розійшовся з
# declare_id!, тому копія кладеться в target/deploy перед кожною збіркою.
sync_keypair() {
  mkdir -p target/deploy
  if [[ -f "$KEYS" ]]; then
    cp "$KEYS" target/deploy/caprail-keypair.json
  fi
  if [[ -f "$HOOK_KEYS" ]]; then
    cp "$HOOK_KEYS" target/deploy/caprail_hook-keypair.json
  fi
}

# Артефакт, який іде в мережу, — SBPFv0. `anchor build` на цьому тулчейні пише
# v3 (`e_flags = 3`), а Agave 3.1.10 такий байткод не запускає ніяк: у генезисі
# він дає `Program is not deployed`, loader-v4 відмовляє на `invalid file
# header`. Тому перевіряємо заголовок, а не вірю на слово команді збірки.
check_v0() {
  local so flags
  for so in "$SO" "$HOOK_SO"; do
    flags="$(readelf -h "$so" | awk '/Flags:/ {print $2}')"
    if [[ "$flags" != "0x0" ]]; then
      echo "ПОМИЛКА: $so має e_flags=$flags, очікувалось 0x0 (SBPFv0)"
      exit 1
    fi
  done
}

# Кадр `try_accounts` під v0 — жорсткий ліміт 4 КіБ, і збірка про це каже
# рядком «overwrites values in the frame», не помилкою. Ловимо його тут, бо
# інакше артефакт «збирається», а перша ж інструкція з великим контекстом
# падає в мережі.
check_frame() {
  if grep -qE 'overwrites values in the frame|exceeded max offset' "$LOG"; then
    echo "ПОМИЛКА: переповнення кадру стека (див. $LOG):"
    grep -E 'overwrites values in the frame|exceeded max offset' "$LOG" | head -5
    exit 1
  fi
}

: >"$LOG"

echo "anchor:  $(anchor --version)"
echo "solana:  $(solana --version)"
echo "sbf:     $(cargo-build-sbf --version | head -1)"
echo "лог:     $LOG"
echo

case "$CMD" in
  build-sbf)
    for program in "${PROGRAMS[@]}"; do
      run cargo-build-sbf --manifest-path "programs/$program/Cargo.toml"
    done
    check_frame
    check_v0
    echo "OK — $SO: $(stat -c %s "$SO") байтів, SBPFv0"
    echo "OK — $HOOK_SO: $(stat -c %s "$HOOK_SO") байтів, SBPFv0"
    ;;
  idl)
    # Лише заради target/idl/caprail.json; артефакт цієї команди в мережу не йде.
    sync_keypair
    run anchor build
    echo "OK — IDL у target/idl/{caprail,caprail_hook}.json"
    echo "УВАГА: anchor build перезаписав $SO і $HOOK_SO артефактами v3 — перед test/деплоєм: $0 build-sbf"
    ;;
  build)
    # Порядок не довільний: anchor build пише свій v3-артефакт у той самий
    # target/deploy, тож SBF-збірка йде останньою і лишає після себе v0.
    "$0" idl
    "$0" build-sbf
    ;;
  fmt)
    run cargo fmt --all
    echo "OK — формат вирівняний"
    ;;
  fmt-check)
    run cargo fmt --all --check
    echo "OK — формат чистий"
    ;;
  clippy)
    run cargo clippy --workspace --all-targets -- -D warnings
    echo "OK — clippy чистий"
    ;;
  test)
    # Тести хука виконують сам .so, а не хостову збірку крейта.
    if [[ ! -f "$SO" || ! -f "$HOOK_SO" ]]; then
      echo "немає $SO або $HOOK_SO — спершу: $0 build-sbf" >&2
      exit 1
    fi
    # Після `idl` тут лежить v3 — тести ганяли б байткод, який у мережу не йде.
    check_v0
    run cargo test --workspace
    echo "OK — тести пройшли"
    ;;
  gate)
    "$0" fmt-check
    "$0" clippy
    "$0" build-sbf
    "$0" test
    ;;
  *)
    echo "невідома команда: $CMD (build-sbf | idl | build | fmt | fmt-check | clippy | test | gate)" >&2
    exit 2
    ;;
esac
