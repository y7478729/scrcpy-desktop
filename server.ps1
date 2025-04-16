$port = 8000
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$adbBatFilePath = Join-Path $scriptDir "adb-command.bat"
$scrcpyBatFilePath = Join-Path $scriptDir "scrcpy-command.bat"

$global:deviceSerial = $null
$global:dynamicDisplayID = $null

# Function to execute an ADB command with polling
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
            # Execute ADB command
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
            Write-Host "ADB Exit Code: $exitCode"
            Write-Host "ADB Stdout: $stdout"
            Write-Host "ADB Stderr: $stderr"
            # Check if the command output matches the success pattern or exit code is 0
            if ($exitCode -eq 0 -and ($successPattern -eq "" -or $stdout -match $successPattern)) {
                Write-Host "ADB command succeeded."
                return @{ Success = $true; Stdout = $stdout; Stderr = $stderr }
            } else {
                Write-Warning "ADB command attempt failed with exit code $exitCode. Stderr: $stderr"
            }
        } catch {
            Write-Warning "Error executing ADB command: $_"
        }
        # Wait before polling again
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $endTime)
    Write-Error "ADB command failed after timeout."
    return @{ Success = $false; Stdout = $null; Stderr = "ADB command failed after timeout." }
}

# Function to get the first USB device
function Get-FirstUsbDevice {
    param (
        [string[]]$devices
    )
    foreach ($device in $devices) {
        if ($device -notmatch ":\d+$") {
            return $device
        }
    }
    return $null
}

# Function to get the first WiFi device
function Get-FirstWifiDevice {
    param (
        [string[]]$devices
    )
    foreach ($device in $devices) {
        if ($device -match ":\d+$") {
            return $device
        }
    }
    return $null
}

# Add this function to your PowerShell script
function Get-DeviceIpAddress {
    param (
        [string]$serial
    )
    $ipResult = Invoke-AdbCommand "adb -s $serial shell ip addr show wlan0" -timeoutSeconds 5 -successPattern "inet "
    if ($ipResult.Success) {
        # Extract IP from output (e.g., "inet 192.168.1.100/24")
        if ($ipResult.Stdout -match "inet (\d+\.\d+\.\d+\.\d+)/") {
            return $matches[1]
        }
    }
    return $null
}

# Function to detect device and return its model
function Detect-Device {
    param (
        [string]$mode,
        [string]$ip
    )
    $adbDevicesResult = Invoke-AdbCommand "adb devices" -successPattern "\bdevice\b"
    if (-not $adbDevicesResult.Success) {
        throw "Failed to execute adb devices: $($adbDevicesResult.Stderr)"
    }

    $lines = $adbDevicesResult.Stdout -split "`n" | Where-Object { $_.Trim() }
    $allDevices = @()
    foreach ($line in $lines) {
        if ($line -match "^([^\s]+)\s+device\s*$") {
            $allDevices += $matches[1]
        }
    }

    if ($mode -eq "usb") {
        $usbDevice = Get-FirstUsbDevice -devices $allDevices
        if (-not $usbDevice) {
            throw "No USB devices found."
        }
        $adbModelResult = Invoke-AdbCommand "adb -s $usbDevice shell getprop ro.product.model" -timeoutSeconds 5 -successPattern ""
        if (-not $adbModelResult.Success) {
            throw "Failed to retrieve phone model: $($adbModelResult.Stderr)"
        }
		
        return @{ success = $true; model = $adbModelResult.Stdout.Trim(); serial = $usbDevice; ip = $null } # IP will be null for USB
    }
    elseif ($mode -eq "wifi") {
        if (-not $ip) {
            # Attempt to fetch IP if USB is connected
            $usbDevice = Get-FirstUsbDevice -devices $allDevices
            if ($usbDevice) {
                $ipAddress = Get-DeviceIpAddress -serial $usbDevice
                if ($ipAddress) {
                    $wifiDeviceName = "$ipAddress`:5555"
                    $adbConnectResult = Invoke-AdbCommand "adb connect $wifiDeviceName" -timeoutSeconds 5 -successPattern "connected to $wifiDeviceName"
                    if ($adbConnectResult.Success) {
                        $adbModelResult = Invoke-AdbCommand "adb -s $wifiDeviceName shell getprop ro.product.model" -timeoutSeconds 5 -successPattern ""
                        if ($adbModelResult.Success) {
                            return @{ success = $true; model = $adbModelResult.Stdout.Trim(); serial = $wifiDeviceName; ip = $ipAddress }
                        }
                    }
                }
            }
            throw "IP address is required for WiFi mode and could not be auto-detected."
        }
        $wifiDeviceName = "$ip`:5555"
        $wifiDevice = Get-FirstWifiDevice -devices $allDevices
        if ($wifiDevice -ne $wifiDeviceName) {
            $adbConnectResult = Invoke-AdbCommand "adb connect $wifiDeviceName" -timeoutSeconds 5 -successPattern "connected to $wifiDeviceName"
            if (-not $adbConnectResult.Success) {
                throw "Failed to connect to WiFi device: $($adbConnectResult.Stderr)"
            }
        }
        $adbModelResult = Invoke-AdbCommand "adb -s $wifiDeviceName shell getprop ro.product.model" -timeoutSeconds 5 -successPattern ""
        if (-not $adbModelResult.Success) {
            throw "Failed to retrieve phone model: $($adbModelResult.Stderr)"
        }
        return @{ success = $true; model = $adbModelResult.Stdout.Trim(); serial = $wifiDeviceName; ip = $ip }
    }
    else {
        throw "Invalid connection mode."
    }
}

# Function to handle connection
function Connect-Device {
    param (
        [string]$mode,
        [string]$ip
    )
    if ($mode -eq "usb") {
        return @{ success = $true; message = "USB connection complete." }
    }
    elseif ($mode -eq "wifi") {
        if (-not $ip) {
            throw "IP address is required for WiFi mode."
        }
        $wifiDeviceName = "$ip"
        $adbConnectResult = Invoke-AdbCommand "adb connect $wifiDeviceName" -timeoutSeconds 5 -successPattern "connected to $wifiDeviceName"
        if (-not $adbConnectResult.Success) {
            throw "Failed to connect to WiFi device: $($adbConnectResult.Stderr)"
        }
        return @{ success = $true; message = "WiFi connection complete." }
    }
    else {
        throw "Invalid connection mode."
    }
}

# Function to get the dynamic display ID and set it globally
function Get-DynamicDisplayId {
    param (
        [string]$serial,
        [string]$resolution,
        [string]$dpi
    )

    # Reset overlays
    Invoke-AdbCommand "adb -s $serial shell settings put global overlay_display_devices none" -timeoutSeconds 5 -successPattern ""

    # List initial displays
    $initialResult = Invoke-AdbCommand "scrcpy -s $serial --list-displays" -timeoutSeconds 5 -successPattern "--display-id"
    $initialIds = @()
    if ($initialResult.Success) {
        foreach ($line in $initialResult.Stdout -split "`n") {
            if ($line -match "--display-id=(\d+)") {
                $initialIds += [int]$matches[1]
            }
        }
    }
    Write-Host "Static display IDs detected: $initialIds"

    # Create overlay display with user-specified resolution and DPI
    $overlaySetting = "$resolution/$dpi"
    Invoke-AdbCommand "adb -s $serial shell settings put global overlay_display_devices $overlaySetting" -timeoutSeconds 5 -successPattern ""

    # List displays again
    $updatedResult = Invoke-AdbCommand "scrcpy -s $serial --list-displays" -timeoutSeconds 5 -successPattern "--display-id"
    $updatedIds = @()
    if ($updatedResult.Success) {
        foreach ($line in $updatedResult.Stdout -split "`n") {
            if ($line -match "--display-id=(\d+)") {
                $updatedIds += [int]$matches[1]
            }
        }
    }

    # Identify the new dynamic ID
    $newIds = $updatedIds | Where-Object { $_ -notin $initialIds }
    if ($newIds.Count -eq 0) {
        Write-Host "No new display ID found after creating overlay."
        $global:dynamicDisplayID = $null
        return
    }

    $global:dynamicDisplayID = $newIds[0]
    Write-Host "Dynamic display ID detected: $global:dynamicDisplayID for $overlaySetting"
}

# Function to reset display settings (overlays, size, density, and rotation)
function Reset-Display {
    param (
        [string]$serial
    )
    Write-Host "Resetting display settings for device: $serial"
	
    Invoke-AdbCommand "adb -s $serial shell settings put global overlay_display_devices none" -timeoutSeconds 5 -successPattern ""
    Invoke-AdbCommand "adb -s $serial shell wm size reset" -timeoutSeconds 5 -successPattern ""
    Invoke-AdbCommand "adb -s $serial shell wm density reset" -timeoutSeconds 5 -successPattern ""
    Invoke-AdbCommand "adb -s $serial shell settings put system user_rotation 0" -timeoutSeconds 5 -successPattern ""
}

try {
    $listener.Start()
    Write-Host "Server running on http://localhost:$port/"
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        # Serve HTML at root (/)
        if ($request.Url.LocalPath -eq "/") {
            try {
                $htmlPath = Join-Path $scriptDir "index.html"
				if (Test-Path $htmlPath) {
					# Read the file as raw bytes
					$buffer = [System.IO.File]::ReadAllBytes($htmlPath)
					$response.ContentType = "text/html; charset=utf-8"
					$response.ContentLength64 = $buffer.Length
					$response.OutputStream.Write($buffer, 0, $buffer.Length)
					Write-Host "Served index.html successfully"
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

        # Handle /detect-device endpoint
		elseif ($request.Url.LocalPath -eq "/detect-device") {
			$response.ContentType = "application/json"
			try {
				$body = New-Object System.IO.StreamReader($request.InputStream)
				$jsonPayload = $body.ReadToEnd()
				$body.Close()
				$requestData = ConvertFrom-Json $jsonPayload
				$connectionMode = $requestData.mode
				$ipAddress = $requestData.ip
				Write-Host "Detecting device in mode: $connectionMode"
				$result = Detect-Device -mode $connectionMode -ip $ipAddress
				$global:deviceSerial = $result.serial
				$jsonResponse = @{ success = $true; model = $result.model; ip = $result.ip } | ConvertTo-Json
			} catch {
				$jsonResponse = @{ success = $false; message = $_.Exception.Message } | ConvertTo-Json
			}
			$buffer = [System.Text.Encoding]::UTF8.GetBytes($jsonResponse)
			$response.ContentLength64 = $buffer.Length
			$response.OutputStream.Write($buffer, 0, $buffer.Length)
			$response.Close()
		}

        # Handle /connect-device endpoint
        elseif ($request.Url.LocalPath -eq "/connect-device") {
            $response.ContentType = "application/json"
            try {
                $body = New-Object System.IO.StreamReader($request.InputStream)
                $jsonPayload = $body.ReadToEnd()
                $body.Close()
                $requestData = ConvertFrom-Json $jsonPayload
                $connectionMode = $requestData.mode
                $ipAddress = $requestData.ip
                Write-Host "Connecting device in mode: $connectionMode"
                $result = Connect-Device -mode $connectionMode -ip $ipAddress
                $jsonResponse = @{ success = $true; message = $result.message } | ConvertTo-Json
            } catch {
                $jsonResponse = @{ success = $false; message = $_.Exception.Message } | ConvertTo-Json
            }
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($jsonResponse)
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()
        }
		
        # Handle /start-scrcpy endpoint
        elseif ($request.Url.LocalPath -eq "/start-scrcpy") {
            $response.ContentType = "text/plain; charset=utf-8" # Ensure UTF-8
            $successMessage = "Scrcpy session started!"
            $errorMessage = $null
            # Declare resetNeeded here so it's accessible in the final catch block
            $resetNeeded = $false

            try {
                # --- 1. Prerequisites ---
                if (-not $global:deviceSerial) {
                    throw "No device selected or connection lost."
                }

                # Verify device connection using Invoke-AdbCommand with direct command
                Write-Host "Verifying device connection: $global:deviceSerial"
                # Use adb directly in the command string
                $checkResult = Invoke-AdbCommand -command "adb -s $global:deviceSerial get-state" -timeoutSeconds 5
                if (-not $checkResult.Success) {
                    Write-Warning "Device $global:deviceSerial connection check failed: $($checkResult.Stderr)"
                    $currentSerial = $global:deviceSerial # Store for message
                    $global:deviceSerial = $null         # Invalidate serial
                    throw "Device $currentSerial connection lost: $($checkResult.Stderr). Please re-detect."
                }
                 Write-Host "Device $global:deviceSerial connection verified."


                # --- 2. Input Parsing ---
                $body = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                $jsonPayload = $body.ReadToEnd()
                $body.Close()
                $config = ConvertFrom-Json $jsonPayload
                Write-Host "Received Scrcpy configuration: $($config | ConvertTo-Json -Depth 3)"

                # --- 3. Base Command Arguments ---
                # We build the final command string later for the batch file
                $scrcpyArgs = @(
                    '-s', $global:deviceSerial
                )

                # --- 4. State Variables ---
                # resetNeeded declared outside try block
                $applyRotationLockParam = $true # Whether to add --capture-orientation

                # --- 5. Mode Handling ---
                if ($config.useSamsungDex) {
                    Write-Host "Mode: Samsung DeX"
                    $scrcpyArgs += '--display-id=2'
                    $resetNeeded = $false            # DeX doesn't change system settings we need to reset
                    $applyRotationLockParam = $false # Ignore rotation lock for DeX
                }
                elseif ($config.useVirtualDisplay) {
                    Write-Host "Mode: Virtual Display"
                    if ($config.resolution -and $config.dpi) {
                        # ASSUMPTION: Get-DynamicDisplayId function exists and uses Invoke-AdbCommand internally
                        # It should already be calling Invoke-AdbCommand with "adb ..." and "scrcpy ..." commands
                        Get-DynamicDisplayId -serial $global:deviceSerial -resolution $config.resolution -dpi $config.dpi
                        # Get-DynamicDisplayId sets a global variable $global:dynamicDisplayID
                        if ($global:dynamicDisplayID -ne $null) {
                            $scrcpyArgs += "--display-id=$($global:dynamicDisplayID)"
                            $resetNeeded = $true # Created an overlay, need reset
                            Write-Host "Using dynamic display ID: $($global:dynamicDisplayID) for virtual display"
                        } else {
                            Write-Warning "Failed to create dynamic display ID for Virtual Mode (check Get-DynamicDisplayId logs). Aborting."
                            throw "Could not create virtual display. Check ADB/Scrcpy logs."
                        }
                    } else {
                        Write-Warning "Virtual Display selected but Resolution/DPI missing. Using default display (0)."
                    }
                    Write-Host "Applying rotation lock (if specified) for Virtual Display mode."
                }
                elseif ($config.useNativeTaskbar) {
                    Write-Host "Mode: Native Taskbar"
                    $scrcpyArgs += '--display-id=0'
                    $applyRotationLockParam = $false

                    # Apply Res/DPI via wm commands using direct adb commands
                    if ($config.resolution) {
                        try {
                            if ($config.resolution -match '^(\d+)x(\d+)$') {
                                $targetResolution = $config.resolution
                                # Use adb directly in the command string
                                $wmSizeResult = Invoke-AdbCommand -command "adb -s $global:deviceSerial shell wm size $targetResolution" -timeoutSeconds 5
                                if (-not $wmSizeResult.Success) { throw "Failed to set wm size: $($wmSizeResult.Stderr)" }
                                $resetNeeded = $true
                            } else {
                                Write-Warning "Invalid resolution format '$($config.resolution)'. Skipping resolution set."
                            }
                        } catch {
                            Write-Warning "Failed to set resolution $($config.resolution) for Native Taskbar: $($_.Exception.Message). Skipping."
                            $resetNeeded = $true
                        }
                    }
                    if ($config.dpi) {
                        try {
                            if ($config.dpi -match '^\d+$') {
                                # Use adb directly in the command string
                                $wmDensityResult = Invoke-AdbCommand -command "adb -s $global:deviceSerial shell wm density $config.dpi" -timeoutSeconds 5
                                if (-not $wmDensityResult.Success) { throw "Failed to set wm density: $($wmDensityResult.Stderr)" }
                                $resetNeeded = $true
                            } else {
                                Write-Warning "Invalid DPI format '$($config.dpi)'. Skipping DPI set."
                            }
                        } catch {
                            Write-Warning "Failed to set DPI $($config.dpi) for Native Taskbar: $($_.Exception.Message). Skipping."
                            $resetNeeded = $true
                        }
                    }

                    # Force landscape rotation via settings using direct adb command
                    try {
                         # Use adb directly in the command string
                         $rotationResult = Invoke-AdbCommand -command "adb -s $global:deviceSerial shell settings put system user_rotation 1" -timeoutSeconds 5
                         if (-not $rotationResult.Success) { throw "Failed to set user_rotation: $($rotationResult.Stderr)" }
                         $resetNeeded = $true
                    } catch {
                        Write-Warning "Failed to set rotation for Native Taskbar: $($_.Exception.Message). Skipping."
                        $resetNeeded = $true
                    }
                    Write-Host "Ignoring separate orientation lock for Native Taskbar mode (using forced landscape via settings)."
                }
                else { # Default Mode (can also use dynamic display if Res/DPI provided)
                    Write-Host "Mode: Default / Dynamic Display"
                    if ($config.resolution -and $config.dpi) {
                        # ASSUMPTION: Get-DynamicDisplayId function exists and uses Invoke-AdbCommand internally
                        # It should already be calling Invoke-AdbCommand with "adb ..." and "scrcpy ..." commands
                        Get-DynamicDisplayId -serial $global:deviceSerial -resolution $config.resolution -dpi $config.dpi
                        if ($global:dynamicDisplayID -ne $null) {
                            $scrcpyArgs += "--display-id=$($global:dynamicDisplayID)"
                            $resetNeeded = $true
                            Write-Host "Using dynamic display ID: $($global:dynamicDisplayID) for default mode"
                        } else {
                            Write-Warning "Failed to create dynamic display ID (check Get-DynamicDisplayId logs). Using default display 0."
                        }
                    }
                }

                # --- 6. Common Options ---
                if ($config.bitrate) { $scrcpyArgs += $config.bitrate }
                if ($config.maxFps) { $scrcpyArgs += $config.maxFps }

                # Add rotation lock param if applicable for the mode and provided
                if ($applyRotationLockParam -and $config.rotationLock) {
                    $scrcpyArgs += $config.rotationLock
                } elseif (-not $applyRotationLockParam -and $config.rotationLock) {
                    Write-Host "Ignoring user-specified orientation lock ($($config.rotationLock)) due to selected mode."
                }

                # Add other boolean options from the checkbox list
                if ($config.options -is [array]) {
                    $validOptions = $config.options | Where-Object { $_ -ne $null -and $_ -ne '' }
                    if ($validOptions) {
                         $scrcpyArgs += $validOptions
                    }
                }

                # --- 7. Execution via Batch File (Ensures Reset After Scrcpy Exits) ---
                # Build the final command string starting directly with scrcpy
                $finalScrcpyCommand = "scrcpy $($scrcpyArgs -join ' ')"
                Write-Host "Final Scrcpy Command to be executed: $finalScrcpyCommand"

                # Build batch file content, calling adb and scrcpy directly
                $batContent = "@echo off`r`n"
                $batContent += "$finalScrcpyCommand`r`n" # No $SCRCPY_PATH variable

                # Add reset commands to the batch file *if needed*, calling adb directly
                if ($resetNeeded) {
                    Write-Host "Display reset commands will be added to batch file for execution after Scrcpy exits."
                    # No $ADB_PATH variable
                    $batContent += "adb -s $global:deviceSerial shell settings put global overlay_display_devices none`r`n"
                    $batContent += "adb -s $global:deviceSerial shell wm size reset`r`n"
                    $batContent += "adb -s $global:deviceSerial shell wm density reset`r`n"
                    $batContent += "adb -s $global:deviceSerial shell settings put system user_rotation 0`r`n"
                } else {
                    Write-Host "No display reset needed for this mode."
                }

                # Ensure script directory exists and save the batch file
                if (-not (Test-Path $scriptDir)) { New-Item -ItemType Directory -Path $scriptDir -Force | Out-Null }
                Set-Content -Path $scrcpyBatFilePath -Value $batContent -Encoding OEM -Force

                # Execute the batch file asynchronously
                Write-Host "Executing Scrcpy via batch file: $scrcpyBatFilePath"
                Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$scrcpyBatFilePath`"" -WindowStyle Minimized

            } catch {
                # Catch errors from prerequisite checks, JSON parsing, ADB/Scrcpy commands, etc.
                $errorMessage = "Error starting Scrcpy: $($_.Exception.Message)"
                Write-Error $errorMessage
                $response.StatusCode = 500

                # Attempt cleanup if needed
                if ($resetNeeded -and $global:deviceSerial) {
                    Write-Warning "Attempting display reset due to error during startup..."
                    try {
                        # ASSUMPTION: Reset-Display uses Invoke-AdbCommand with direct "adb ..." commands
                        Reset-Display -serial $global:deviceSerial
                    } catch {
                        Write-Warning "Cleanup reset failed: $($_.Exception.Message)"
                    }
                }
            } # End of main Try block for /start-scrcpy

            # --- 8. Send Response ---
            $messageToSend = if ($errorMessage) { $errorMessage } else { $successMessage }
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($messageToSend)
            $response.ContentLength64 = $buffer.Length
            try {
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
            } catch {
                 Write-Error "Failed to write response to client: $_"
            } finally {
                 $response.Close()
            }
        }	

		elseif ($request.Url.LocalPath -eq "/update-app") {
			$response.ContentType = "text/plain"
			try {
				$repoOwner = "serifpersia"
				$repoName = "scrcpy-desktop"
				$apiUrl = "https://api.github.com/repos/$repoOwner/$repoName/releases/latest"
				Write-Host "Fetching latest release from $apiUrl"
				$release = Invoke-RestMethod -Uri $apiUrl -Method Get -Headers @{ "User-Agent" = "PowerShell" }
				
				# Print release details for debugging
				Write-Host "Release Details:"
				Write-Host "  Tag Name: $($release.tag_name)"
				Write-Host "  Published At: $($release.published_at)"
				Write-Host "  Commit SHA: $($release.target_commitish)"
				Write-Host "  Assets Count: $($release.assets.Count)"
				Write-Host "Assets Available:"
				if ($release.assets.Count -eq 0) {
					Write-Host "  (No manually uploaded assets)"
				} else {
					foreach ($asset in $release.assets) {
						Write-Host "  - Name: $($asset.name)"
						Write-Host "    URL: $($asset.browser_download_url)"
					}
				}

				# Use the tag to construct the source code ZIP URL
				$tag = $release.tag_name
				$zipUrl = "https://github.com/$repoOwner/$repoName/archive/refs/tags/$tag.zip"
				Write-Host "Downloading source code ZIP from $zipUrl"

				$zipPath = "$scriptDir\temp_update.zip"
				Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
				
				$tempDir = "$scriptDir\temp_update_dir"
				Write-Host "Extracting ZIP to $tempDir"
				if (Test-Path $tempDir) {
					Remove-Item -Path $tempDir -Recurse -Force
				}
				Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
				
				# Get the extracted subdirectory (e.g., scrcpy-desktop-latest)
				$extractedDir = Get-ChildItem -Path $tempDir -Directory | Select-Object -First 1
				if (-not $extractedDir) {
					throw "No subdirectory found in extracted ZIP."
				}
				$extractedPath = $extractedDir.FullName
				Write-Host "Extracted directory: $extractedPath"
				Write-Host "Files in extracted directory:"
				Get-ChildItem -Path $extractedPath -Recurse | ForEach-Object {
					Write-Host "  - $($_.FullName)"
				}

				# Copy the required files
				$filesToCopy = @("index.html", "server.py", "server.ps1")
				$missingFiles = @()
				foreach ($file in $filesToCopy) {
					$sourcePath = Join-Path -Path $extractedPath -ChildPath $file
					$destPath = Join-Path -Path $scriptDir -ChildPath $file
					if (Test-Path -Path $sourcePath) {
						Write-Host "Copying $sourcePath to $destPath"
						Copy-Item -Path $sourcePath -Destination $destPath -Force
					} else {
						Write-Warning "File not found in ZIP: $sourcePath"
						$missingFiles += $file
					}
				}

				if ($missingFiles.Count -gt 0) {
					throw "Missing files in ZIP: $($missingFiles -join ', ')"
				}

				Write-Host "Cleaning up temporary files"
				Remove-Item -Path $zipPath -Force
				Remove-Item -Path $tempDir -Recurse -Force
				
				$buffer = [System.Text.Encoding]::UTF8.GetBytes("Update successful. Restarting server...")
				Write-Host "Update successful, sending response"
				$response.ContentLength64 = $buffer.Length
				$response.OutputStream.Write($buffer, 0, $buffer.Length)
				$response.Close()
				
				Write-Host "Restarting server"
				$listener.Stop()
				Start-Sleep -Seconds 1
				Start-Process -FilePath "powershell.exe" -ArgumentList "-File `"$PSCommandPath`"" -NoNewWindow
			} catch {
				$errorMessage = "Error updating app: $_"
				Write-Host $errorMessage
				$buffer = [System.Text.Encoding]::UTF8.GetBytes($errorMessage)
				$response.ContentLength64 = $buffer.Length
				try {
					$response.OutputStream.Write($buffer, 0, $buffer.Length)
					$response.Close()
				} catch {
					Write-Host "Failed to send error response: $_"
				}
			}
		}
        # Handle 404 for unknown paths
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
    if ($listener.IsListening) {
        $listener.Stop()
        $listener.Close()
    }
    Write-Host "Server has stopped."
}