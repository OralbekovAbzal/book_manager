; Правило брандмауэра Windows для Roomline PMS.
;
; Зачем. Хост слушает TCP-порт сервера (по умолчанию 4780) и UDP 4781 «я здесь»,
; рабочие места шлют широковещательный запрос и принимают ответ. Windows при
; первом запуске показывает окно «Разрешить доступ?», которое приходится
; подтверждать от имени администратора — а на стойке нажимают «Отмена», и потом
; «программа не видит хост» без единой подсказки. Ставим правило сами, при
; установке: установщик и так идёт с правами администратора (perMachine).
;
; ПОЧЕМУ ОДНО ПРАВИЛО ПО ПРОГРАММЕ, А НЕ ТРИ ПО ПОРТАМ. Сервер — это тот же
; самый exe, запущенный в режиме node (ELECTRON_RUN_AS_NODE), поэтому правило на
; программу покрывает разом: TCP-порт сервера (его сисадмин может сменить в
; «Настройке системы» — правило по порту пришлось бы переписывать), UDP 4781 на
; хосте и приём ответов на рабочем месте.
;
; Sysnative: NSIS 32-битный, и "$WINDIR\System32" перенаправляется ему в SysWOW64,
; где netsh.exe нет. Псевдопапка Sysnative даёт 32-битному процессу настоящую
; System32. На 32-битной Windows её нет — там годится обычный путь.

!macro customInstall
  Push $R0
  StrCpy $R0 "$WINDIR\Sysnative\netsh.exe"
  IfFileExists "$R0" +2 0
  StrCpy $R0 "$WINDIR\System32\netsh.exe"

  ; Сначала удаляем — при обновлении поверх старой версии правило уже есть, и
  ; второй add создал бы дубль (а если изменился путь установки — ещё и мёртвый).
  nsExec::ExecToLog '"$R0" advfirewall firewall delete rule name="Roomline PMS"'
  Pop $0
  nsExec::ExecToLog '"$R0" advfirewall firewall add rule name="Roomline PMS" dir=in action=allow program="$INSTDIR\Roomline PMS.exe" enable=yes profile=any'
  Pop $0
  DetailPrint "Правило брандмауэра «Roomline PMS»: $0"
  Pop $R0
!macroend

!macro customUnInstall
  Push $R0
  StrCpy $R0 "$WINDIR\Sysnative\netsh.exe"
  IfFileExists "$R0" +2 0
  StrCpy $R0 "$WINDIR\System32\netsh.exe"

  nsExec::ExecToLog '"$R0" advfirewall firewall delete rule name="Roomline PMS"'
  Pop $0
  Pop $R0
!macroend
