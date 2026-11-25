// Invoke only fixed PowerShell programs. Paths and URLs are passed as data.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';

const exec = promisify(execFile);
export function windowsCommand(script, values = {}) {
  const executable = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const program = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script;
  return exec(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
    env: { ...process.env, ...values }, windowsHide: true, timeout: 15000, maxBuffer: 65536,
  }).catch(error => {
    throw new Error('Windows 系统操作失败，请检查当前用户的安装目录及访问权限', { cause: error });
  });
}

// Validate NTFS ACLs, including ancestors that could replace a protected leaf.
// Never alter an existing ACL. Create a private DACL for newly created runtime directories.
export async function windowsPathAccess(file, { create = false, privateData = true, program = false } = {}) {
  await windowsCommand(`
$p=[IO.Path]::GetFullPath($env:KM_WIN_PATH)
if ($p -notmatch '^[a-zA-Z]:\\\\') { throw 'Expected local drive' }
$roots=@([Environment]::GetFolderPath('UserProfile'))
if ($env:KM_WIN_PROGRAM -eq '1') { $roots += @($env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) }
$root=$roots | Where-Object { $_ -and $p.StartsWith($_.TrimEnd('\\')+'\\',[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
if (!$root) { throw 'Expected a path under the user profile or an installed program' }
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted=@($sid.Value,'S-1-5-18','S-1-5-32-544')
if ($env:KM_WIN_PROGRAM -eq '1') { $trusted+='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' }
$aclNew=[Security.AccessControl.DirectorySecurity]::new()
$aclNew.SetOwner($sid)
$aclNew.SetAccessRuleProtection($true,$false)
foreach ($who in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
  $aclNew.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($who),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
$current=$root
foreach ($part in @('') + $p.Substring($root.Length).TrimStart('\\').Split('\\')) {
  $current=[IO.Path]::Combine($current,$part)
  $item=Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
  if (!$item) {
    if ($env:KM_WIN_CREATE -ne '1' -or !$part) { throw 'Missing path' }
    [void][IO.Directory]::CreateDirectory($current,$aclNew)
    $item=Get-Item -LiteralPath $current -Force
  }
  if ($env:KM_WIN_CREATE -eq '1' -and !$item.PSIsContainer) { throw 'Expected a directory' }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsupported reparse point' }
  $acl=Get-Acl -LiteralPath $current
  if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Unexpected owner' }
  if (!$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]).Count) { throw 'Expected explicit or inherited access rules' }
  $mask=0xD0156
  $privateLeaf=$current -eq $p -and $env:KM_WIN_PRIVATE -eq '1'
  if ($privateLeaf) { $mask=$mask -bor 1 }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    $inheritOnly=$rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly
    if ($inheritOnly -and (!$privateLeaf -or $rule.IdentityReference.Value -eq 'S-1-3-0')) { continue }
    if ($rule.AccessControlType -eq 'Allow' -and
        ($rule.FileSystemRights.value__ -band $mask) -and $trusted -notcontains $rule.IdentityReference.Value) { throw 'Unexpected access rule' }
  }
}
`, { KM_WIN_PATH: file, KM_WIN_CREATE: create ? '1' : '0', KM_WIN_PRIVATE: privateData ? '1' : '0', KM_WIN_PROGRAM: program ? '1' : '0' });
}

export async function openWebUrl(address) {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('无效的浏览器地址');
  await windowsCommand('Start-Process -FilePath $env:KM_WIN_URL', { KM_WIN_URL: url.href });
}
