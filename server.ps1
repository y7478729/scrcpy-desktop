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
			$response.ContentType = "text/plain"
			try {
				$body = New-Object System.IO.StreamReader($request.InputStream)
				$jsonPayload = $body.ReadToEnd()
				$body.Close()
				$config = ConvertFrom-Json $jsonPayload
				Write-Host "Received Scrcpy configuration: $($config | ConvertTo-Json)"
				
				# Helper function to build the Scrcpy command
				function Build-ScrcpyCommand {
					param (
						[string]$deviceSerial,
						[bool]$useVirtualDisplay,
						[bool]$useNativeTaskbar,
						[string]$resolution,
						[string]$dpi,
						[string]$bitrate,
						[string[]]$options,
						[string]$maxFps,
						[string]$rotationLock,
						[string]$displayId = $null
					)
					$command = "scrcpy -s $deviceSerial"
					
					# Handle power-related options
					$powerOptions = @("--no-power-on", "--turn-screen-off", "--power-off-on-close")
					foreach ($opt in $powerOptions) {
						if ($options -contains $opt) {
							$command += " $opt"
						}
					}

					if ($useVirtualDisplay) {
						if ($resolution) { 
							$command += " --new-display=$resolution" 
						}
						if ($dpi) { 
							$command += "/$dpi" 
						}
					}
					elseif ($useNativeTaskbar) {
						if ($resolution) {
							$width, $height = $resolution -split 'x'
							$swappedResolution = "$height" + "x" + "$width"  # Swap width and height
							Write-Host "Swapped resolution for native taskbar: $swappedResolution"
							
							# Set screen size and density
							Invoke-AdbCommand "adb -s $deviceSerial shell wm size $swappedResolution" -timeoutSeconds 5 -successPattern ""
							$calculatedDpi = [math]::Round(0.2667 * [int]$height)
							Write-Host "Calculated DPI: $calculatedDpi for resolution: $resolution"
							Invoke-AdbCommand "adb -s $deviceSerial shell wm density $calculatedDpi" -timeoutSeconds 5 -successPattern ""
							Invoke-AdbCommand "adb -s $deviceSerial shell settings put system user_rotation 1" -timeoutSeconds 5 -successPattern ""
							$command += " --display-id=0"
						}
						$resetNeeded = $true
					}
					elseif ($displayId) {
						$command += " --display-id=$displayId"
						$resetNeeded = $true
					}
					
					if ($bitrate) { 
						$command += " $bitrate" 
					}
					if ($options) { 
						$command += " $($options -join ' ')" 
					}
					if ($maxFps) { 
						$command += " $maxFps" 
					}
					if ($rotationLock) { 
						$command += " $rotationLock" 
					}
					
					return @{ Command = $command; ResetNeeded = $resetNeeded }
				}

				# Construct the Scrcpy command dynamically
				if ($config.useVirtualDisplay) {
					$scrcpyCommandInfo = Build-ScrcpyCommand `
						-deviceSerial $global:deviceSerial `
						-useVirtualDisplay $true `
						-resolution $config.resolution `
						-dpi $config.dpi `
						-bitrate $config.bitrate `
						-options $config.options `
						-maxFps $config.maxFps `
						-rotationLock $config.rotationLock
				}
				elseif ($config.useNativeTaskbar) {
					$scrcpyCommandInfo = Build-ScrcpyCommand `
						-deviceSerial $global:deviceSerial `
						-useNativeTaskbar $true `
						-resolution $config.resolution `
						-bitrate $config.bitrate `
						-options $config.options `
						-maxFps $config.maxFps `
						-rotationLock $config.rotationLock
				}
				else {
					# Get the dynamic display ID with user-specified resolution and DPI
					Get-DynamicDisplayId -serial $global:deviceSerial -resolution $config.resolution -dpi $config.dpi
					if (-not $global:dynamicDisplayID) {
						throw "Could not determine a valid dynamic display ID."
					}
					$scrcpyCommandInfo = Build-ScrcpyCommand `
						-deviceSerial $global:deviceSerial `
						-displayId $global:dynamicDisplayID `
						-bitrate $config.bitrate `
						-options $config.options `
						-maxFps $config.maxFps `
						-rotationLock $config.rotationLock
				}

				# Save the command to a batch file
				$batContent = "@echo off`n"
				$batContent += "$($scrcpyCommandInfo.Command)`n"
				if ($scrcpyCommandInfo.ResetNeeded) {
					$batContent += "adb -s $global:deviceSerial shell settings put global overlay_display_devices none`n"
					$batContent += "adb -s $global:deviceSerial shell wm size reset`n"
					$batContent += "adb -s $global:deviceSerial shell wm density reset`n"
					$batContent += "adb -s $global:deviceSerial shell settings put system user_rotation 0`n"
				}
				Set-Content -Path $scrcpyBatFilePath -Value $batContent

				# Execute the Scrcpy command
				Write-Host "Executing Scrcpy command: $batContent"
				$scrcpyProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$scrcpyBatFilePath`"" -NoNewWindow -PassThru -RedirectStandardError "scrcpy_error.log"
				if (-not $scrcpyProcess.HasExited) {
					Write-Host "Scrcpy started successfully with PID: $($scrcpyProcess.Id)"
					$buffer = [System.Text.Encoding]::UTF8.GetBytes("Scrcpy Desktop is running!")
				} else {
					$errorOutput = Get-Content -Path "scrcpy_error.log" -Raw
					Write-Host "Scrcpy failed to start: $errorOutput"
					$buffer = [System.Text.Encoding]::UTF8.GetBytes("Error: Scrcpy failed to start. $errorOutput")
				}
			} catch {
				Write-Host "Error: $_"
				$buffer = [System.Text.Encoding]::UTF8.GetBytes("Error: $_")
			}
			$response.ContentLength64 = $buffer.Length
			$response.OutputStream.Write($buffer, 0, $buffer.Length)
			$response.Close()
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