param([ValidateSet('pos','kitchen','captain')][string]$Mode = 'pos')
# Launch only; regular users never need file access to restaurant state.
$outletRoute = switch ($Mode) { 'kitchen' { '/kitchen/' }; 'captain' { '/captain/' }; default { '/' } }
Start-Process ('https://localhost:4443' + $outletRoute)
