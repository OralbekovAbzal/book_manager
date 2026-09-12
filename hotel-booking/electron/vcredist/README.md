# Среда выполнения Visual C++ для встроенного Postgres

`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll` — Microsoft Visual C++ Redistributable
(x64, 14.50.35719.0, подписаны Microsoft). Взяты из `C:\Windows\System32` машины сборки;
эти же файлы Microsoft разрешает распространять вместе с приложением («app-local deployment»,
список в `redist.txt` Visual Studio).

**Зачем.** `initdb.exe`, `postgres.exe`, `pg_ctl.exe`, `libpq.dll`, ICU и OpenSSL из пакета
`@embedded-postgres/windows-x64` собраны MSVC и импортируют эти библиотеки, а в пакете их нет.
На чистой Windows без установленного «Visual C++ Redistributable» `initdb` не запускается вовсе:
код выхода `3221225781` (`0xC0000135`, STATUS_DLL_NOT_FOUND) — так упал первый запуск на чужом
ноутбуке 12.09.2026. Ставить редистрибутив отдельно нельзя: клиент не должен ничего доустанавливать.

**Как попадают в сборку.** `electron/package.json` → `extraResources` копирует папку в
`resources/app/node_modules/@embedded-postgres/windows-x64/native/bin` — туда же, где лежат
`initdb.exe` и `postgres.exe`; Windows ищет DLL сначала в папке исполняемого файла. Установленный
в системе редистрибутив при этом не мешает: своя копия рядом с exe имеет приоритет.

Обновлять при смене версии `embedded-postgres`, если бинарники начнут требовать другую версию
рантайма (проверка: `grep -a -o -iE "(vcruntime|msvcp)[0-9_]*\.dll" bin/postgres.exe`).
