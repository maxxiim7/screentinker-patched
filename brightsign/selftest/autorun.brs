' ScreenTinker — storage self-test.
'
' NOT the player. This is the smallest known-good BrightScript that proves the player is reading
' the card at all, copied from the dev-cookbook html-starter example so the script itself is not
' a variable.
'
' If the screen shows the green panel: storage is fine, and any failure is in the real autorun.brs
' or downstream (network, server, widget config).
' If the screen still says "Please insert storage device": the player is not reading this medium,
' and no amount of work on the player code will help.

function main()
	mp = CreateObject("roMessagePort")

	vidmode = CreateObject("roVideoMode")
	width = vidmode.GetResX()
	height = vidmode.GetResY()
	r = CreateObject("roRectangle", 0, 0, width, height)

	config = {
		nodejs_enabled: true
		brightsign_js_objects_enabled: true
		url: "file:/FLASH:/index.html"
		port: mp
	}

	h = CreateObject("roHtmlWidget", r, config)
	h.Show()

	while true
		msg = wait(0, mp)
		print "msg received - type=";type(msg)
	end while
end function
