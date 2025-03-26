$port = 8000
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$adbBatFilePath = Join-Path $scriptDir "adb-command.bat"
$scrcpyBatFilePath = Join-Path $scriptDir "scrcpy-command.bat"

$global:deviceSerial = $null

# Function to execute an ADB command with polling
function Invoke-AdbCommand {
    param (
        [string]$command,
        [int]$timeoutSeconds = 5,
        [string]$successPattern = "\bdevice\b"
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
        $ipAddress = Get-DeviceIpAddress -serial $usbDevice
        return @{ success = $true; model = $adbModelResult.Stdout.Trim(); serial = $usbDevice; ip = $ipAddress }
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
						[bool]$useAndroid_11,
						[string]$resolution,
						[string]$dpi,
						[string]$bitrate,
						[string[]]$options,
						[string]$maxFps,
						[string]$rotationLock
					)
					$command = "scrcpy -s $deviceSerial"
					if ($useAndroid_11) {
						if ($resolution) { 
							$command += " --new-display=$resolution" 
						}
						if ($dpi) { 
							$command += "/$dpi" 
						}
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
					return $command
				}

				# Construct the Scrcpy command dynamically
				if ($config.useAndroid_11) {
					$scrcpyCommand = Build-ScrcpyCommand `
						-deviceSerial $global:deviceSerial `
						-useAndroid_11 $true `
						-resolution $config.resolution `
						-dpi $config.dpi `
						-bitrate $config.bitrate `
						-options $config.options `
						-maxFps $config.maxFps `
						-rotationLock $config.rotationLock
				} else {
					$scrcpyCommand = "@echo off`n"
					$scrcpyCommand += "adb -s $global:deviceSerial shell settings put global overlay_display_devices $($config.resolution)/$($config.dpi)`n"
					$scrcpyCommand += 'for /f "tokens=2 delims==" %%a in (''scrcpy -s ' + $global:deviceSerial + ' --list-displays 2^>^&1 ^| find "--display-id"'') do (' + "`n"
					$scrcpyCommand += '  for /f "tokens=1 delims= " %%b in ("%%a") do (' + "`n"
					$scrcpyCommand += '    if not "%%b"=="0" ( set "DISPLAY_ID=%%b" )' + "`n"
					$scrcpyCommand += '  )' + "`n"
					$scrcpyCommand += ')' + "`n"
					$scrcpyCommand += "if defined DISPLAY_ID ( " + (Build-ScrcpyCommand `
						-deviceSerial $global:deviceSerial `
						-useAndroid_11 $false `
						-resolution $null `
						-dpi $null `
						-bitrate $config.bitrate `
						-options $config.options `
						-maxFps $config.maxFps `
						-rotationLock $config.rotationLock) + " --display-id %DISPLAY_ID% ) else ( echo No valid display ID found. )`n"
					$scrcpyCommand += "adb -s $global:deviceSerial shell settings put global overlay_display_devices none"
				}

				# Save the command to a batch file
				Set-Content -Path $scrcpyBatFilePath -Value $scrcpyCommand

				# Execute the Scrcpy command
				Write-Host "Executing Scrcpy command: $scrcpyCommand"
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