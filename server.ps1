$port = 8000
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$scrcpyBatFilePath = Join-Path $scriptDir "scrcpy-command.bat"

$global:deviceSerial = $null
$global:dynamicDisplayID = $null

function Invoke-AdbCommand {
    param (
        [string]$command,
        [int]$timeoutSeconds = 5,
        [string]$successPattern = ""
    )
    Write-Host "Executing ADB command: $command"
    $startTime = Get-Date
    $endTime = $startTime.AddSeconds($timeoutSeconds)
    do {
        try {
            $processInfo = New-Object System.Diagnostics.ProcessStartInfo
            $processInfo.FileName = "cmd.exe"
            $processInfo.Arguments = "/c $command"
            $processInfo.RedirectStandardOutput = $true
            $processInfo.RedirectStandardError = $true
            $processInfo.UseShellExecute = $false
            $processInfo.CreateNoWindow = $true
            $process = [System.Diagnostics.Process]::Start($processInfo)
            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
            Write-Host "  Exit Code: $exitCode"
            Write-Host "  Stdout: $($stdout.Trim())"
            Write-Host "  Stderr: $($stderr.Trim())"

            if ($exitCode -eq 0 -and ($successPattern -eq "" -or $stdout -match $successPattern)) {
                Write-Host "  Command succeeded."
                return @{ Success = $true; Stdout = $stdout; Stderr = $stderr }
            } else {
                Write-Warning "  Command attempt failed."
            }
        } catch {
            Write-Warning "  Error executing ADB command: $_"
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $endTime)
    Write-Error "ADB command failed after timeout."
    return @{ Success = $false; Stdout = $null; Stderr = "ADB command failed after timeout." }
}

function Get-FirstUsbDevice {
    param (
        [string[]]$devices
    )
    foreach ($device in $devices) {
        if ($device -notmatch ":\d+$" -and $device -ne "List of devices attached") {
            Write-Host "Detected USB device: $device"
            return $device
        }
    }
    return $null
}

function Get-FirstWifiDevice {
    param (
        [string[]]$devices
    )
    foreach ($device in $devices) {
        if ($device -match ":\d+$") {
            Write-Host "Detected WiFi device: $device"
            return $device
        }
    }
    return $null
}

function Get-DeviceIpAddress {
    param (
        [string]$serial
    )
    Write-Host "Attempting to get IP for device: $serial"
    $ipResult = Invoke-AdbCommand "adb -s $serial shell ip addr show wlan0" -timeoutSeconds 5 -successPattern "inet "
    if ($ipResult.Success) {
        if ($ipResult.Stdout -match "inet (\d+\.\d+\.\d+\.\d+)/") {
            Write-Host "  Found IP: $($matches[1])"
            return $matches[1]
        }
    }
    Write-Host "  Could not determine IP."
    return $null
}

function Detect-Device {
    param (
        [string]$mode,
        [string]$ip
    )
    Write-Host "Detecting device in mode: $mode"
    $adbDevicesResult = Invoke-AdbCommand "adb devices" -successPattern "\bdevice\b"
    if (-not $adbDevicesResult.Success) {
        throw "Failed to execute adb devices: $($adbDevicesResult.Stderr)"
    }

    $lines = $adbDevicesResult.Stdout -split "`n" | Where-Object { $_.Trim() -ne "List of devices attached" }
    $allDevices = @()
    foreach ($line in $lines) {
        if ($line -match "^([^\s]+)\s+device\s*$") {
            $allDevices += $matches[1]
        }
    }
    Write-Host "Found total devices: $($allDevices -join ', ')"

    if ($mode -eq "usb") {
        $usbDevice = Get-FirstUsbDevice -devices $allDevices
        if (-not $usbDevice) {
            throw "No USB devices found."
        }
        Write-Host "Selected USB device: $usbDevice"
        $adbModelResult = Invoke-AdbCommand "adb -s $usbDevice shell getprop ro.product.model" -timeoutSeconds 5 -successPattern ""
        if (-not $adbModelResult.Success) {
            throw "Failed to retrieve phone model: $($adbModelResult.Stderr)"
        }
        $ipAddress = $null
        return @{ success = $true; model = $adbModelResult.Stdout.Trim(); serial = $usbDevice; ip = $ipAddress }
    }
    elseif ($mode -eq "wifi") {
        if (-not $ip) {
            Write-Host "No IP provided for WiFi, attempting auto-detection via USB..."
            $usbDevice = Get-FirstUsbDevice -devices $allDevices
            if ($usbDevice) {
                $ipAddress = Get-DeviceIpAddress -serial $usbDevice
                if ($ipAddress) {
                    Write-Host "Auto-detected IP: $ipAddress. Enabling TCP/IP mode on USB device."
                    Invoke-AdbCommand "adb -s $usbDevice tcpip 5555" -timeoutSeconds 15 -successPattern "" | Out-Null
                    Start-Sleep -Seconds 2
                    $ip = $ipAddress
                } else {
                    throw "Could not auto-detect IP address from USB device. Please ensure WiFi is connected on the device."
                }
            } else {
                throw "IP address is required for WiFi mode and no USB device found for auto-detection."
            }
        }
        $wifiDeviceName = "$ip`:5555"
        Write-Host "Attempting ADB connect to WiFi device: $wifiDeviceName"

        Invoke-AdbCommand "adb disconnect $wifiDeviceName" -timeoutSeconds 5 -successPattern "" | Out-Null
        Start-Sleep -Seconds 1

        $adbConnectResult = Invoke-AdbCommand "adb connect $wifiDeviceName" -timeoutSeconds 15 -successPattern "connected to $wifiDeviceName|already connected to $wifiDeviceName"
        if (-not $adbConnectResult.Success) {
            throw "Failed to connect to WiFi device ${wifiDeviceName}: $($adbConnectResult.Stderr)"
        }
        Write-Host "Connected to ${wifiDeviceName}"

        $wifiSerial = $wifiDeviceName

        $adbModelResult = Invoke-AdbCommand "adb -s $wifiSerial shell getprop ro.product.model" -timeoutSeconds 5 -successPattern ""
        if (-not $adbModelResult.Success) {
            throw "Failed to retrieve phone model from ${wifiSerial}: $($adbModelResult.Stderr)"
        }
        return @{ success = $true; model = $adbModelResult.Stdout.Trim(); serial = $wifiSerial; ip = $ip }
    }
    else {
        throw "Invalid connection mode."
    }
}

function Connect-Device {
    param (
        [string]$mode,
        [string]$ip
    )
    Write-Host "Connecting device in mode: $mode"

     if (-not $global:deviceSerial) {
        throw "No device serial available. Please run detection first."
    }

    Write-Host "Verifying connection for serial: $global:deviceSerial"
    $checkResult = Invoke-AdbCommand "adb -s $global:deviceSerial get-state" -timeoutSeconds 5
    if (-not $checkResult.Success -or $checkResult.Stdout.Trim() -ne "device") {
        $currentSerial = $global:deviceSerial
        $global:deviceSerial = $null
        throw "Device $currentSerial connection lost: $($checkResult.Stderr). Please re-detect."
    }
     Write-Host "Connection for $global:deviceSerial verified."

    if ($mode -eq "usb") {
        return @{ success = $true; message = "USB connection verified." }
    }
    elseif ($mode -eq "wifi") {
        $expectedSerial = "$ip`:5555"

        if ($global:deviceSerial -ne $expectedSerial) {
             Write-Host "WiFi serial ($global:deviceSerial) doesn't match expected IP ($expectedSerial). Attempting re-connect."
             $adbConnectResult = Invoke-AdbCommand "adb connect $expectedSerial" -timeoutSeconds 15 -successPattern "connected to $expectedSerial|already connected to $expectedSerial"
             if (-not $adbConnectResult.Success) {
                 throw "Failed to re-connect to WiFi device ${expectedSerial}: $($adbConnectResult.Stderr)"
             }
             $global:deviceSerial = $expectedSerial
             Write-Host "Re-connection to ${expectedSerial} successful."
         } else {
             Write-Host "WiFi serial matches expected IP. Connection verified."
         }

        return @{ success = $true; message = "WiFi connection verified." }
    }
    else {
        throw "Invalid connection mode."
    }
}


function Get-DynamicDisplayId {
    param (
        [string]$serial,
        [string]$resolution,
        [string]$dpi
    )
    Write-Host "Attempting to get dynamic display ID for $resolution/$dpi on $serial"

    Invoke-AdbCommand "adb -s $serial shell settings put global overlay_display_devices none" -timeoutSeconds 5 -successPattern "" | Out-Null

    $initialResult = Invoke-AdbCommand "scrcpy -s $serial --list-displays" -timeoutSeconds 10 -successPattern "--display-id"
    $initialIds = @()
    if ($initialResult.Success) {
        foreach ($line in $initialResult.Stdout -split "`n") {
            if ($line -match "--display-id=(\d+)") {
                $initialIds += [int]$matches[1]
            }
        }
    }
    Write-Host "  Static display IDs detected: $($initialIds -join ', ')"

    $overlaySetting = "$resolution/$dpi"
    Write-Host "  Creating overlay display with setting: $overlaySetting"
    Invoke-AdbCommand "adb -s $serial shell settings put global overlay_display_devices $overlaySetting" -timeoutSeconds 5 -successPattern "" | Out-Null
    Start-Sleep -Seconds 2

    $updatedResult = Invoke-AdbCommand "scrcpy -s $serial --list-displays" -timeoutSeconds 10 -successPattern "--display-id"
    $updatedIds = @()
    if ($updatedResult.Success) {
        foreach ($line in $updatedResult.Stdout -split "`n") {
            if ($line -match "--display-id=(\d+)") {
                $updatedIds += [int]$matches[1]
            }
        }
    }
    Write-Host "  Updated display IDs: $($updatedIds -join ', ')"

    $newIds = $updatedIds | Where-Object { $_ -notin $initialIds }
    if ($newIds.Count -eq 0) {
        Write-Host "  No new display ID found after creating overlay. Resetting."
        Invoke-AdbCommand "adb -s $serial shell settings put global overlay_display_devices none" -timeoutSeconds 5 -successPattern "" | Out-Null
        $global:dynamicDisplayID = $null
        return
    }

    $global:dynamicDisplayID = $newIds[0]
    Write-Host "  Dynamic display ID detected: $global:dynamicDisplayID"
}

function Reset-Display {
    param (
        [string]$serial
    )
    Write-Host "Resetting display settings for device: $serial"

    Invoke-AdbCommand "adb -s $serial shell settings put global overlay_display_devices none" -timeoutSeconds 5 -successPattern "" | Out-Null
    Invoke-AdbCommand "adb -s $serial shell wm size reset" -timeoutSeconds 5 -successPattern "" | Out-Null
    Invoke-AdbCommand "adb -s $serial shell wm density reset" -timeoutSeconds 5 -successPattern "" | Out-Null
    Invoke-AdbCommand "adb -s $serial shell settings put system user_rotation 0" -timeoutSeconds 5 -successPattern "" | Out-Null
    Write-Host "Display settings reset complete."
}

try {
    $listener.Start()
    Write-Host "Server running on http://localhost:$port/"
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        if ($request.Url.LocalPath -eq "/") {
            try {
                $htmlPath = Join-Path $scriptDir "index.html"
				if (Test-Path $htmlPath) {
					$buffer = [System.IO.File]::ReadAllBytes($htmlPath)
					$response.ContentType = "text/html; charset=utf-8"
					$response.ContentLength64 = $buffer.Length
					$response.OutputStream.Write($buffer, 0, $buffer.Length)
				}
				else {
                    $response.StatusCode = 404
                    $buffer = [System.Text.Encoding]::UTF8.GetBytes("Error: index.html not found")
                    $response.ContentLength64 = $buffer.Length
                    $response.OutputStream.Write($buffer, 0, $buffer.Length)
                }
            } catch {
                $response.StatusCode = 500
                $buffer = [System.Text.Encoding]::UTF8.GetBytes("Error serving HTML: $_")
                $response.ContentLength64 = $buffer.Length
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            $response.Close()
        }

		elseif ($request.Url.LocalPath -eq "/detect-device") {
			$response.ContentType = "application/json"
			try {
				$body = New-Object System.IO.StreamReader($request.InputStream)
				$jsonPayload = $body.ReadToEnd()
				$body.Close()
				$requestData = ConvertFrom-Json $jsonPayload
				$connectionMode = $requestData.mode
				$ipAddress = $requestData.ip
                Write-Host "Received /detect-device request (Mode: $connectionMode, IP: $ipAddress)"
				$result = Detect-Device -mode $connectionMode -ip $ipAddress
				$global:deviceSerial = $result.serial
				$jsonResponse = @{ success = $true; model = $result.model; ip = $result.ip } | ConvertTo-Json
                Write-Host "Sending detect-device response: $($jsonResponse)"
			} catch {
                Write-Error "Error in /detect-device: $_"
				$jsonResponse = @{ success = $false; message = $_.Exception.Message } | ConvertTo-Json
                $response.StatusCode = 500
			}
			$buffer = [System.Text.Encoding]::UTF8.GetBytes($jsonResponse)
			$response.ContentLength64 = $buffer.Length
			$response.OutputStream.Write($buffer, 0, $buffer.Length)
			$response.Close()
		}

        elseif ($request.Url.LocalPath -eq "/connect-device") {
            $response.ContentType = "application/json"
            try {
                $body = New-Object System.IO.StreamReader($request.InputStream)
                $jsonPayload = $body.ReadToEnd()
                $body.Close()
                $requestData = ConvertFrom-Json $jsonPayload
                $connectionMode = $requestData.mode
                $ipAddress = $requestData.ip
                Write-Host "Received /connect-device request (Mode: $connectionMode, IP: $ipAddress)"
                $result = Connect-Device -mode $connectionMode -ip $ipAddress
                $jsonResponse = @{ success = $true; message = $result.message } | ConvertTo-Json
                Write-Host "Sending connect-device response: $($jsonResponse)"
            } catch {
                Write-Error "Error in /connect-device: $_"
                $jsonResponse = @{ success = $false; message = $_.Exception.Message } | ConvertTo-Json
                $response.StatusCode = 500
            }
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($jsonResponse)
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()
        }

        elseif ($request.Url.LocalPath -eq "/start-scrcpy") {
            $response.ContentType = "text/plain; charset=utf-8"
            $successMessage = "Scrcpy session started!"
            $errorMessage = $null
            $resetNeeded = $false
            $finalScrcpyCommand = "Error generating command"

            try {
                Write-Host "Received /start-scrcpy request"
                if (-not $global:deviceSerial) {
                    throw "No device selected or connection lost."
                }
                 Write-Host "Verifying device connection: $global:deviceSerial"
                $checkResult = Invoke-AdbCommand -command "adb -s $global:deviceSerial get-state" -timeoutSeconds 5
                if (-not $checkResult.Success -or $checkResult.Stdout.Trim() -ne "device") {
                    $currentSerial = $global:deviceSerial
                    $global:deviceSerial = $null
                    throw "Device $currentSerial connection lost: $($checkResult.Stderr). Please re-detect."
                }
                 Write-Host "Device connection verified."

                $body = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                $jsonPayload = $body.ReadToEnd()
                $body.Close()
                $config = ConvertFrom-Json $jsonPayload
                Write-Host "Received Scrcpy configuration:"
                $config | Format-List | Out-String | Write-Host

                $scrcpyArgs = @(
                    '-s', $global:deviceSerial
                )

                $applyRotationLockParam = $true

                if ($config.useSamsungDex) {
                    Write-Host "Mode: Samsung DeX selected."
                    $scrcpyArgs += '--display-id=2'
                    $resetNeeded = $false
                    $applyRotationLockParam = $false
                }
				
                elseif ($config.useVirtualDisplay) {
                    Write-Host "Mode: Virtual Display"
                    if ($config.resolution -and $config.dpi) {
                        $scrcpyArgs += "--new-display=$($config.resolution)/$($config.dpi)"
                        $resetNeeded = $false
					}
                }
				
                elseif ($config.useNativeTaskbar) {
                    Write-Host "Mode: Native Taskbar selected."
                    $scrcpyArgs += '--display-id=0'
                    $applyRotationLockParam = $false
                    $resetNeeded = $false
                    $heightInt = $null

                    if ($config.resolution) {
                        try {
                            Write-Host "  Attempting to set resolution: $($config.resolution)"
                            if ($config.resolution -match '^(\d+)x(\d+)$') {
                                $heightInt = [int]$matches[2]
                                $targetResolution = $config.resolution
                                $wmSizeResult = Invoke-AdbCommand -command "adb -s $global:deviceSerial shell wm size $targetResolution" -timeoutSeconds 5
                                if (-not $wmSizeResult.Success) { throw ("{0}" -f $wmSizeResult.Stderr) }
                                Write-Host "  Resolution set OK."
                                $resetNeeded = $true
                            } else { Write-Warning "  Invalid resolution format." }
                        } catch {
                            Write-Warning ("  Failed to set resolution: {0}. $_" -f $_.Exception.Message)
                            $heightInt = $null
                        }
                    }

                    $finalDpiToSet = $null
                    if ($config.dpi) {
                        try {
                            Write-Host "  Attempting to set DPI: $($config.dpi)"
                            if ($config.dpi -match '^\d+$') {
                                $userDpiInt = [int]$config.dpi
                                if ($heightInt -ne $null) {
                                    $maxDpi = [math]::Round(0.2667 * $heightInt)
                                    Write-Host "  Calculated max DPI based on height ($heightInt): $maxDpi"
                                    $finalDpiToSet = [math]::Min($userDpiInt, $maxDpi)
                                    if ($finalDpiToSet -ne $userDpiInt) { Write-Host "  Capping DPI to $finalDpiToSet." }
                                } else {
                                    Write-Host "  Height unknown, using user DPI: $userDpiInt"
                                    $finalDpiToSet = $userDpiInt
                                }

                                if ($finalDpiToSet -ne $null) {
                                    $wmDensityResult = Invoke-AdbCommand -command "adb -s $global:deviceSerial shell wm density $finalDpiToSet" -timeoutSeconds 5
                                    if (-not $wmDensityResult.Success) { throw ("{0}" -f $wmDensityResult.Stderr) }
                                    Write-Host "  DPI set OK."
                                    $resetNeeded = $true
                                }
                            } else { Write-Warning "  Invalid DPI format." }
                        } catch {
                            Write-Warning ("  Failed to set DPI: {0}. $_" -f $_.Exception.Message)
                        }
                    }

                    try {
                         Write-Host "  Setting rotation to landscape."
                         $rotationResult = Invoke-AdbCommand -command "adb -s $global:deviceSerial shell settings put system user_rotation 1" -timeoutSeconds 5
                         if (-not $rotationResult.Success) { throw ("{0}" -f $rotationResult.Stderr) }
                         Write-Host "  Rotation set OK."
                         $resetNeeded = $true
                    } catch {
                        Write-Warning ("  Failed to set rotation: {0}. $_" -f $_.Exception.Message)
                    }
                }
                else {
                    Write-Host "Mode: Default selected."
                    if ($config.resolution -and $config.dpi) {
                        Write-Host "  Resolution: $($config.resolution), DPI: $($config.dpi)"
                        Get-DynamicDisplayId -serial $global:deviceSerial -resolution $config.resolution -dpi $config.dpi
                        if ($global:dynamicDisplayID -ne $null) {
                            $scrcpyArgs += "--display-id=$($global:dynamicDisplayID)"
                            $resetNeeded = $true
                        } else {
                            Write-Warning "  Failed to create dynamic display for Default mode."
                             $resetNeeded = $false
                        }
                    } else {
                         Write-Host "  Resolution/DPI not provided for Default mode. Using primary display."
                         $resetNeeded = $false
                    }
                }

                if ($config.bitrate) { $scrcpyArgs += $config.bitrate }
                if ($config.maxFps) { $scrcpyArgs += $config.maxFps }

                if ($applyRotationLockParam -and $config.rotationLock) {
                    $scrcpyArgs += $config.rotationLock
                } elseif (-not $applyRotationLockParam -and $config.rotationLock) {
                    Write-Host "Ignoring user-specified orientation lock due to selected mode."
                }

                if ($config.options -is [array]) {
                    $validOptions = $config.options | Where-Object { $_ -ne $null -and $_ -ne '' }
                    if ($validOptions) {
                         $scrcpyArgs += $validOptions
                    }
                }

                $finalScrcpyCommand = "scrcpy $($scrcpyArgs -join ' ')"
                Write-Host "Final Scrcpy Command: $finalScrcpyCommand"

                $batContent = "@echo off`r`n"
                $batContent += "$finalScrcpyCommand`r`n"

                if ($resetNeeded) {
                    Write-Host "Adding display reset commands to batch file."
                    $batContent += "adb -s $global:deviceSerial shell settings put global overlay_display_devices none`r`n"
                    $batContent += "adb -s $global:deviceSerial shell wm size reset`r`n"
                    $batContent += "adb -s $global:deviceSerial shell wm density reset`r`n"
                    $batContent += "adb -s $global:deviceSerial shell settings put system user_rotation 0`r`n"
                }

                if (-not (Test-Path $scriptDir)) { New-Item -ItemType Directory -Path $scriptDir -Force | Out-Null }
                Set-Content -Path $scrcpyBatFilePath -Value $batContent -Encoding OEM -Force
                Write-Host "Batch file created: $scrcpyBatFilePath"

                Write-Host "Starting Scrcpy process..."
                Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$scrcpyBatFilePath`"" -WindowStyle Minimized

            } catch {
                $errorMessage = "Error starting Scrcpy: $($_.Exception.Message)"
                Write-Error $errorMessage

                if ($resetNeeded -and $global:deviceSerial) {
                    Write-Warning "Attempting display reset due to error..."
                    try {
                        Reset-Display -serial $global:deviceSerial
                    } catch {
                        Write-Warning "Cleanup reset failed: $($_.Exception.Message)"
                    }
                }
            }

            $messageToSend = if ($errorMessage) { $errorMessage } else { $successMessage }
            $responseContent = "$messageToSend---COMMAND---$finalScrcpyCommand"
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($responseContent)
            $response.ContentLength64 = $buffer.Length
            try {
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
            } catch {
                 Write-Error "Failed to write response to client: $_"
            } finally {
                 if ($errorMessage) { $response.StatusCode = 500 }
                 $response.Close()
            }
        }

		elseif ($request.Url.LocalPath -eq "/update-app") {
			$response.ContentType = "text/plain"
			try {
                Write-Host "Received /update-app request"
				$repoOwner = "serifpersia"
				$repoName = "scrcpy-desktop"
				$apiUrl = "https://api.github.com/repos/$repoOwner/$repoName/releases/latest"
				Write-Host "Fetching latest release from $apiUrl"
				$release = Invoke-RestMethod -Uri $apiUrl -Method Get -Headers @{ "User-Agent" = "PowerShell" }
				
				$tag = $release.tag_name
				$zipUrl = "https://github.com/$repoOwner/$repoName/archive/refs/tags/$tag.zip"
				Write-Host "Downloading source code ZIP from $zipUrl"

				$zipPath = "$scriptDir\temp_update.zip"
				Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
				Write-Host "Downloaded ZIP to $zipPath"

				$tempDir = "$scriptDir\temp_update_dir"
				Write-Host "Extracting ZIP to $tempDir"
				if (Test-Path $tempDir) {
					Remove-Item -Path $tempDir -Recurse -Force
				}
				Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
				Write-Host "ZIP extracted."

				$extractedDir = Get-ChildItem -Path $tempDir -Directory | Select-Object -First 1
				if (-not $extractedDir) {
					throw "No subdirectory found in extracted ZIP."
				}
				$extractedPath = $extractedDir.FullName
				Write-Host "Extracted directory: $extractedPath"

				$filesToCopy = @("index.html", "server.py", "server.ps1")
				$missingFiles = @()
				Write-Host "Copying updated files:"
				foreach ($file in $filesToCopy) {
					$sourcePath = Join-Path -Path $extractedPath -ChildPath $file
					$destPath = Join-Path -Path $scriptDir -ChildPath $file
					if (Test-Path -Path $sourcePath) {
						Write-Host "  Copying $sourcePath to $destPath"
						Copy-Item -Path $sourcePath -Destination $destPath -Force
					} else {
						Write-Warning "  File not found in ZIP: $sourcePath"
						$missingFiles += $file
					}
				}

				if ($missingFiles.Count -gt 0) {
					throw "Missing files in ZIP: $($missingFiles -join ', ')"
				}

				Write-Host "Cleaning up temporary files"
				Remove-Item -Path $zipPath -Force
				Remove-Item -Path $tempDir -Recurse -Force
				Write-Host "Cleanup complete."

				$buffer = [System.Text.Encoding]::UTF8.GetBytes("Update successful. Restarting server...")
				Write-Host "Update successful, sending response and restarting server."
				$response.ContentLength64 = $buffer.Length
				try {
					$response.OutputStream.Write($buffer, 0, $buffer.Length)
					$response.Close()
				} catch {
					Write-Error "Failed to send update success response: $_"
				}

				Write-Host "Restarting server..."
				$listener.Stop()
				Start-Sleep -Seconds 1
				Start-Process -FilePath "powershell.exe" -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`"" -NoNewWindow

			} catch {
				$errorMessage = "Error updating app: $($_.Exception.Message)"
				Write-Error $errorMessage
				$buffer = [System.Text.Encoding]::UTF8.GetBytes($errorMessage)
				$response.ContentLength64 = $buffer.Length
				try {
					$response.OutputStream.Write($buffer, 0, $buffer.Length)
					$response.StatusCode = 500
					$response.Close()
				} catch {
					Write-Error "Failed to send error response: $_"
				}
			}
		}
        else {
            $response.StatusCode = 404
            $buffer = [System.Text.Encoding]::UTF8.GetBytes("Not Found")
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()
        }
    }
} catch {
    Write-Host "Failed to start the server: $_"
} finally {
    if ($listener -and $listener.IsListening) {
        $listener.Stop()
        $listener.Close()
    }
    Write-Host "Server has stopped."
}