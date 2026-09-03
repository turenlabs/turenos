import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ShellSafety } from "@turenlabs/core/shell-safety"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const cwd = "/workspace/project"

const blocked: ReadonlyArray<readonly [ShellSafety.Kind, string]> = [
  ["bash", "rm -rf /"],
  ["bash", 'rm -r "$HOME"'],
  ["bash", "rm -R ."],
  ["bash", "rm --recursive .."],
  ["bash", 'rm -rf "$TARGET"'],
  ["bash", "rm -rf *"],
  ["bash", "sudo -- rm -rf /"],
  ["bash", "command rm -r ~"],
  ["bash", "rm -rf ~tom"],
  ["bash", "rm -rf ~tom/projects"],
  ["bash", "rm -rf ~+"],
  ["bash", "sh -c 'rm -rf /'"],
  // Every shell that takes a command string on -c has to be recognised, or the
  // interpreter defence is one uncommon-but-installed shell away from useless.
  ["bash", "fish -c 'rm -rf /'"],
  ["bash", "csh -c 'rm -rf /'"],
  ["bash", "tcsh -c 'rm -rf /'"],
  ["bash", "ash -c 'rm -rf /'"],
  ["bash", "mksh -c 'rm -rf /'"],
  ["bash", "sudo fish -c 'rm -rf /'"],
  ["bash", "eval rm -rf /"],
  ["bash", "exec rm -rf /"],
  ["bash", "nice -n 5 rm -rf /"],
  ["bash", "timeout -k 1 5 rm -rf /"],
  ["bash", "busybox rm -rf /"],
  ["bash", "stdbuf -o L rm -rf /"],
  ["bash", "$cmd -rf /"],
  ["bash", 'sh -c "$SCRIPT"'],
  ["bash", "r''m -rf *"],
  ["bash", "env -u HOME rm -rf *"],
  ["bash", "env -S 'rm -rf /'"],
  ["bash", "env -S 'rm -rf' ~"],
  ["bash", "env -S 'sudo rm -rf' ~"],
  ["bash", "env -S'env -C .. rm -rf' project"],
  ["bash", "env --split-string='rm -rf' ~"],
  ["bash", "env -C .. rm -rf project"],
  ["bash", "env -C.. rm -rf project"],
  ["bash", "env -iC.. rm -rf project"],
  ["bash", "env -iS 'rm -rf /workspace/project'"],
  ["bash", "env -P /bin rm -rf /workspace/project"],
  ["bash", 'env -P /usr/bin find "$HOME" -delete'],
  ["bash", "sudo --user root find / -delete"],
  ["bash", "env -P /bin sh -c 'rm -rf \"$HOME\"'"],
  ["bash", "sudo --user root sh -c 'rm -rf \"$HOME\"'"],
  ["bash", 'env -P /bin rm -?f "$HOME"'],
  ["bash", "sudo env --chdir=.. rm -rf project"],
  ["bash", "sudo -D .. rm -rf project"],
  ["bash", "sudo --user root rm -rf /workspace/project"],
  ["bash", "eval -- rm -rf /"],
  ["bash", "cd .. && rm -rf project"],
  ["bash", "opts=-rf; rm $opts *"],
  ["bash", "echo $(rm -rf /)"],
  ["bash", "xargs rm -rf"],
  ["bash", "printf '/\\0' | xargs -0 sh -c 'rm -rf \"$1\"' _"],
  ["bash", "printf '/\\0' | xargs -0 s''h -c 'rm -rf \"$1\"' _"],
  ["bash", "find / -delete"],
  ["bash", "find ./dist -delete"],
  ["bash", "find ./dist -exec rm -rf /workspace/project {} +"],
  ["bash", "find / -type f -exec rm -f {} +"],
  ["bash", "find ./link -follow -delete"],
  ["bash", "rm --rec --force /workspace"],
  ["bash", "rm -rf ./cache/link/protected"],
  ["bash", "rm -rf ./link/"],
  ["bash", "rm -rf /workspace/project/link/."],
  ["bash", '{rm,-rf} "$HOME"'],
  ["bash", "r{,x}m -rf /"],
  ["bash", "rm {-,x}{r,} /"],
  ["bash", "rm `printf -- -rf` /"],
  ["bash", "rm -?f /workspace/project"],
  ["bash", "printf 'rm -rf /workspace/project\\n' | sh"],
  ["bash", "find . -exec env rm -rf /workspace/project \\;"],
  ["bash", "printf '/workspace/project\\0' | xargs -0 -I{} find {} -delete"],
  ["bash", "printf 'Remove-Item -Recurse -Force /\\n' | pwsh -NoProfile -Command -"],
  ["powershell", "Remove-Item -Recurse -Force /"],
  ["powershell", "Remove-Item -Recurse -Force '~'"],
  ["powershell", "Microsoft.PowerShell.Management\\Remove-Item -Recurse -Force C:\\workspace"],
  ["powershell", "Remove-Item -Recurse $HOME"],
  ["powershell", "Remove-Item -Recurse ."],
  ["powershell", "rm -r .."],
  ["powershell", "Get-ChildItem / | Remove-Item -Recurse -Force"],
  ["powershell", "Get-ChildItem / | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"],
  ["powershell", "$targets = @('/'); Remove-Item -Recurse -Force @targets"],
  ["powershell", "Remove-Item -Recurse -Force C:.."],
  ["powershell", "Remove-Item -Recurse -Force @('C:\\')"],
  ["powershell", "Remove-Item -Recurse -Force ([IO.Path]::GetPathRoot((Get-Location).Path))"],
  ["powershell", "rd -Recurse -Force C:\\"],
  ["powershell", "& '/bin/rm' -rf /"],
  ["powershell", "& (Get-Command /bin/rm) -rf /"],
  ["powershell", "pwsh -Command 'Remove-Item -Recurse $HOME'"],
  ["powershell", "pwsh -Command Remove-Item -Recurse -Force /"],
  ["powershell", "pwsh -Co Remove-Item -Recurse -Force /"],
  ["powershell", "Invoke-Expression -Command 'Remove-Item -Recurse -Force /'"],
  ["powershell", "Invoke-Expression -Command ('Remove-Item -Recurse -Force C:\\')"],
  ["powershell", "iex -Verbose 'Remove-Item -Recurse -Force $HOME'"],
  ["powershell", "Write-Output 'Remove-Item -Recurse -Force /' | Invoke-Expression"],
  ["powershell", "Write-Output 'Remove-Item -Recurse -Force /' | Invoke-Expression -Verbose"],
  ["powershell", "$p = @{ Recurse = $true; Force = $true }; Remove-Item / @p"],
  ["powershell", "$global:p = @{ Recurse = $true; Force = $true }; Remove-Item C:\\ @global:p"],
  ["powershell", "Remove-Item -Recur`se -Force $HOME"],
  ["powershell", "Remove-It`em -Recurse -Force /"],
  ["powershell", "pwsh -EncodedCommand ZgBvAG8A"],
  ["powershell", "pwsh -EncodedComman`d ZgBvAG8A"],
  ["powershell", "pwsh -Comman`d 'Remove-Item -Recurse -Force /'"],
  ["powershell", "Set-Location ..; Remove-Item -Recurse -Force project"],
  ["powershell", "$go = $true; Remove-Item -Recurse:$go *"],
  ["powershell", "Remove-Item -Recurse -Force ./cache/link/protected"],
  ["cmd", "rmdir /s /q C:\\"],
  ["cmd", "rmdir /s /q %USERPROFILE%"],
  ["cmd", '@rmdir /s /q "%USERPROFILE%"'],
  ["cmd", "@rd /s /q C:\\"],
  ["cmd", 'C:\\Windows\\System32\\cmd.exe /c "rmdir /s /q %USERPROFILE%"'],
  ["cmd", '@cmd /c "rmdir /s /q C:\\"'],
  ["cmd", "@rmdir /^s /q .."],
  ["cmd", 'cmd /^c "rmdir /s /q .."'],
  ["cmd", "echo 'safe & rmdir /s /q .. & echo done'"],
  ["cmd", 'start "" /wait cmd /c "rmdir /s /q .."'],
  ["cmd", 'start "" %COMSPEC% /c "rmdir /s /q .."'],
  ["cmd", 'start "" powershell -Command "Remove-Item -Recurse -Force C:\\"'],
  ["cmd", "echo rmdir /s /q C:\\workspace | cmd"],
  ["cmd", "echo rm -rf /workspace/project | sh -x"],
  ["cmd", 'cmd /c "rmdir /s /q C:\\"'],
  ["cmd", "call rmdir /s /q C:\\"],
  ["cmd", "rmdir /s /q !TARGET!"],
  ["cmd", "cd .. & rmdir /s /q project"],
  ["cmd", 'cmd /v:on /c "set D=del& !D! /s /q C:\\*"'],
  ["cmd", "if exist C:\\ rmdir /s /q C:\\"],
  ["cmd", "if exist C:\\workspace (rmdir /s /q C:\\workspace)"],
  ["cmd", "rd /s/q C:\\workspace"],
  ["cmd", "r^d /s /q C:\\"],
  ["cmd", "setlocal EnableDelayedExpansion & set S=/s & rd !S! /q C:\\workspace"],
  ["cmd", "setlocal EnableDelayedExpansion & set D=rd & @!D! /s /q .."],
  ["cmd", "rmdir /s /q cache\\link\\protected"],
  ["cmd", 'rmdir /s /q ".. "'],
]

const allowed: ReadonlyArray<readonly [ShellSafety.Kind, string]> = [
  ["bash", "rm -rf ./dist"],
  ["bash", "rm -rf /workspace/project/dist"],
  ["bash", "rm -rf /tmp/forge-build-123"],
  ["bash", "rm -f /"],
  ["bash", "echo rm -rf /"],
  ["bash", "sh -c 'rm -rf ./dist'"],
  ["bash", "env -S 'rm -rf' ./dist"],
  ["bash", "sh -c 'echo \"$HOME\"'"],
  ["bash", "rm -- -rf"],
  ["bash", "rm -- -rf /"],
  ["bash", "command -v rm -rf /"],
  ["bash", "rm -rf '~'"],
  ["bash", "rm -rf '*'"],
  ["powershell", "Remove-Item -Recurse -Force ./dist"],
  ["powershell", "Remove-Item -Recurse -Force -ErrorAction $mode ./dist"],
  ["powershell", "Remove-Item -Recurse -Force -EA $mode ./dist"],
  ["powershell", "Remove-Item -Recurse -LiteralPath '[cache]'"],
  ["powershell", "Remove-Item -Recurse -LP '[cache]'"],
  ["powershell", "Remove-Item ./file.txt"],
  ["powershell", "Write-Output 'Remove-Item -Recurse /'"],
  ["cmd", "rmdir /s /q dist"],
  ["cmd", "rmdir dist"],
  ["cmd", "echo rmdir /s C:\\"],
]

describe("ShellSafety", () => {
  for (const [shell, command] of blocked) {
    it.effect(`blocks ${shell}: ${command}`, () =>
      ShellSafety.inspect({ command, cwd, shell }).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toMatchObject({ operation: "recursive-delete" }))),
        Effect.asVoid,
      ),
    )
  }

  for (const [shell, command] of allowed) {
    it.effect(`allows ${shell}: ${command}`, () =>
      ShellSafety.inspect({ command, cwd, shell }).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBeUndefined())),
        Effect.asVoid,
      ),
    )
  }

  it.effect("keeps process safety guidance canonical", () =>
    Effect.sync(() => {
      expect(ShellSafety.PROCESS_SAFETY_GUIDANCE).toContain("PID or process group")
      expect(ShellSafety.PROCESS_SAFETY_GUIDANCE).toContain("pkill -f")
      expect(ShellSafety.PROCESS_SAFETY_GUIDANCE).toContain("harness parent command lines")
    }),
  )

  it.effect("recognizes ancestors when a child component begins with two dots", () =>
    ShellSafety.inspect({ command: "rm -rf /tmp/base", cwd: "/tmp/base/..child", shell: "bash" }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toMatchObject({ reason: "parent-directory" }))),
      Effect.asVoid,
    ),
  )

  it.effect("tracks a cmd control-body delete against a Windows cwd", () =>
    ShellSafety.inspect({
      command: "if exist C:\\workspace rmdir /s /q C:\\workspace",
      cwd: "C:\\workspace",
      shell: "cmd",
    }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toMatchObject({ reason: "working-directory" }))),
      Effect.asVoid,
    ),
  )

  it.effect("reports the first unsafe target in a multi-target cmd delete", () =>
    ShellSafety.inspect({ command: "rmdir /s /q .. dist", cwd, shell: "cmd" }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => expect(result).toMatchObject({ target: "..", reason: "parent-directory" })),
      ),
      Effect.asVoid,
    ),
  )

  it.effect("reports the first unsafe cmd target when the root leads", () =>
    ShellSafety.inspect({ command: "rmdir /s /q C:\\ dist cache", cwd: "C:\\workspace", shell: "cmd" }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => expect(result).toEqual({ operation: "recursive-delete", target: "C:\\", reason: "root" })),
      ),
      Effect.asVoid,
    ),
  )

  it.effect("blocks Windows trailing-space normalization to a parent path", () =>
    ShellSafety.inspect({
      command: "Remove-Item -Recurse -Force '.. '",
      cwd: "C:\\workspace\\project",
      shell: "powershell",
    }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toMatchObject({ operation: "recursive-delete" }))),
      Effect.asVoid,
    ),
  )
})
