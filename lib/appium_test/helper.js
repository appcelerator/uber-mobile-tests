'use strict';

const
	Setup = require('./setup_appium.js'),
	AppcUtil = require('../appc_util.js'),
	Mocha = require('mocha'),
	path = require('path'),
	fs = require('fs-extra'),
	spawn = require('child_process').spawn,
	os = require('os');

const
	TEST_DIR = 'appium_tests',
	TEMP_APP = path.join(__dirname, 'temp'),
	ALLOY_BASE = path.join(__dirname, 'alloy_app'),
	CLASSIC_BASE = path.join(__dirname, 'classic_app'),
	CONFIG_TESTS = require('../../appium_tests/test_config.js').tests,
	CONFIG_SERVER = require('../../appium_tests/test_config.js').server;

const setup = new Setup();

// these will be accessed in the appium mocha tests
global.driver = setup.appiumServer(CONFIG_SERVER);
global.webdriver = setup.getWd();

exports.test = function (platforms, done, bail) {
	let
		ranAlready = '',
		appiumProc = null,
		playerPid = -1;

	let p = new Promise(resolve => {
		// start the local appium server
		appiumProc = _runAppium(CONFIG_SERVER, resolve);
	});

	_createTests(platforms).forEach(test => {
		p = p.then(() => {
			_genTestApp(test.app);
		})
		.then(() => {
			return new Promise((resolve, reject) => {
				let platform = test.cap.platformName === 'iOS' ? 'ios' : 'android';
				_buildTestApp(platform, resolve, reject);
			});
		})
		.then(() => {
			return new Promise((resolve, reject) => {
				if (test.cap.platformName !== 'Android') {
					return resolve();
				}
				// need to launch the genymotion emulator first.
				// appium won't launch it like it does for ios simulators.
				_launchGeny(test.cap.deviceName, resolve, reject);
			})
			.then(pid => {
				playerPid = pid;
			});
		})
		.then(() => {
			// expose which device is being used to the test suites
			global.curDevice = {
				name: test.cap.deviceName,
				ver: test.cap.platformVersion
			};

			console.log(`Installing ${test.cap.app} to ${test.cap.deviceName} ...`);
			// TODO: need a flag if we want more logging
			return setup.startClient(test.cap, false);
		})
		.then(() => {
			return new Promise(resolve => {
				// grrrrr, can't run the same test suite twice in mocha; need to apply this workaround
				// https://github.com/mochajs/mocha/issues/995
				if (ranAlready === test.mocha) {
					for (let file in require.cache) {
						// seems safe: http://stackoverflow.com/a/11477602
						delete require.cache[file];
					}
				}
				ranAlready = test.mocha;

				// this is also part of the above workaround
				new Mocha({
					useColors: false,
					fullStackTrace: true
				})
				.addFile(test.mocha)
				.run(() => {
					resolve();
				});
			});
		})
		.then(() => {
			// sever the connection between the client device and appium server
			return setup.stopClient();
		})
		.then(() => {
			return new Promise(resolve => {
				if (test.cap.platformName !== 'Android') {
					resolve();
					return;
				}
				// quit the currently running genymotion emulator
				_quitGeny(playerPid, resolve);
			});
		})
		.then(() => {
			// delete TEMP_APP to prepare for the next test suite
			return fs.removeSync(TEMP_APP);
		});
	});

	p.then(() => {
		console.log('Done running Appium tests.');
		done();
	})
	.catch(bail)
	.then(() => {
		_killAppium(appiumProc);
	});
};

/**
	starts and run the local appium server.

	@param {Object} server - the server property from test_config.js
	@param {Function} done - the callback to call when the server is up and running
**/
function _runAppium(server, done) {
	let appiumExe = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'appium');
	if (os.platform() === 'win32') {
		// use the windows compatible appium script
		appiumExe += '.cmd';
	}

	const flags = ['--log-no-colors'];

	const cmd = AppcUtil.spawnConvert(appiumExe, flags);

	const prc = spawn(cmd, flags);

	prc.stdout.on('data', output => {
		const line = output.toString().trim();

		const
			regStr = `started on (0\\.0\\.0\\.0|${server.host})\\:${server.port}$`,
			isRunning = new RegExp(regStr, 'g').test(line);
		if (isRunning) {
			console.log(`Local Appium server started on ${server.host}:${server.port}`);
			done();
		}

		const isShutDown = '[Appium] Received SIGTERM - shutting down' === line;
		if (isShutDown) {
			console.log('Appium server shutting down ...');
		}
	});
	prc.stderr.on('data', output => {
		console.log(output.toString());
	});
	prc.on('error', err => {
		console.log(err.stack);
	});

	return prc;
}

/**
	a wrapper to kill the spawned local appium server process.

	NOTE: running appiumProc.kill() on windows only kills the parent, which orphans its child processes.
	'taskkill' should kill the parent and it's children.
**/
function _killAppium(appiumProc) {
	if (os.platform() === 'win32') {
		console.log('Appium server shutting down ...');
		spawn('taskkill', ['/PID', appiumProc.pid, '/T', '/F']);
	} else {
		appiumProc.kill();
	}
}

/**
	generate a list of objects that contains the following:
		- absolute path to the target mocha file
		- absolute path target test app
		- specified appium capabilities.

	@param {Array} platforms - a list of supported platforms
	@return {Array} - an array of json objects; the object properies are defined as:
		{
			mocha: absolute path to the target mocha file,
			app: absolute path to the target test app,
			cap: valid appium's capabilities; https://github.com/appium/appium/blob/master/docs/en/writing-running-appium/default-capabilities-arg.md
		}
**/
function _createTests(platforms) {
	const suites = [];

	platforms.forEach(platform => {
		const tests = CONFIG_TESTS[platform];

		for (let suite in tests) {
			// ignore 'desiredCapabilities'; it's not a suite
			if (suite !== 'desiredCapabilities') {
				const
					mochaFile = __absPathTo(`${suite}${path.sep}${platform}.js`),
					testApp = __absPathTo(path.join(suite, tests[suite].proj)); // contents will be copied into TEST_DIR

				try {
					fs.statSync(mochaFile);
					fs.statSync(testApp);
				} catch (err) {
					throw new Error(`'${err.path}' doesn't exist in '${TEST_DIR}' directory.`);
				}

				const
					desiredCap = tests.desiredCapabilities,
					targetSuite = tests[suite],
					appBuildDir = path.join(TEMP_APP, 'build');

				switch (platform) {
					case 'ios':
						desiredCap.platformName = 'iOS';

						// appium needs an absolute path to the specified built mobile app (simulator only for now)
						const iosApp = path.join(appBuildDir, 'iphone', 'build', 'Products', 'Debug-iphonesimulator', `${targetSuite.proj}.app`);
						desiredCap.app = iosApp;
						break;

					case 'android':
						desiredCap.platformName = 'Android';

						// for android, appium requires these two properties
						desiredCap.appPackage = targetSuite.appPackage;
						desiredCap.appActivity = targetSuite.appActivity;

						// appium needs an absolute path to the specified built mobile app
						const androidApk = path.join(appBuildDir, 'android', 'bin', `${targetSuite.proj}.apk`);
						desiredCap.app = androidApk;
						break;

					// NOTE: no default case is needed; there's a platform check in test.js
				}

				// it is possible for a test suite to have multiple target test devices
				targetSuite.testDevices.forEach(device => {
					// Object.assign() makes a shallow copy (propertry and values only) of desiredCap object
					const desires = Object.assign({}, desiredCap);
					desires.deviceName = device.deviceName;
					desires.platformVersion = device.platformVersion;

					suites.push({
						mocha: mochaFile,
						app: testApp,
						cap: desires
					});
				});
			}
		}
	});

	function __absPathTo(file) {
		return path.join(__dirname, '..', '..', TEST_DIR, file);
	}

	return suites;
}

/**
	Create a temporary app using the base app (alloy_app or classic_app) and target testApp.

	@param {String} testApp - Path to the target test app
**/
function _genTestApp(testApp) {
	console.log(`Copying ${testApp} to '/temp' ...`);

	// check if testApp is a classic or alloy app; if neither, throw an error
	const files = fs.readdirSync(testApp);
	let
		isClassic = false,
		isAlloy = false,
		foundTiapp = false;
	files.forEach(file => {
		// Titanium classic app
		if (file === 'Resources') {
			try {
				const appJs = path.join(testApp, 'Resources', 'app.js');
				fs.statSync(appJs);
				isClassic = true;
			} catch (err) {
				const msg = `${testApp} is a Titanium Classic app. The app needs to have at least 'Resources/app.js'.`;
				throw new Error(msg);
			}
		}
		// Alloy app
		if (file === 'app') {
			try {
				const indexFile = path.join(testApp, 'app', 'controllers', 'index.js');
				fs.statSync(indexFile);
				isAlloy = true;
			} catch (err) {
				const msg = `${testApp} is an Alloy app. The app needs to have at least 'app/controllers/index.js'.`;
				throw new Error(msg);
			}
		}
		// check if the tiapp.xml exists
		if (file === 'tiapp.xml') {
			foundTiapp = true;
		}
	});
	if (!isClassic && !isAlloy) {
		throw new Error(`${testApp} is not a valid mobile app.`);
	}
	if (!foundTiapp) {
		throw new Error(`Cannot find the 'tiapp.xml' in ${testApp}`);
	}

	// create the TEMP_APP folder and copy assets from the base; TEMP_APP will be delete later
	fs.ensureDirSync(TEMP_APP);
	if (isClassic) {
		fs.copySync(CLASSIC_BASE, TEMP_APP);
	} else {
		fs.copySync(ALLOY_BASE, TEMP_APP);
	}

	// copy contents from testApp into TEMP_APP; copySync should be able to handle overwriting existing files/directories
	fs.copySync(testApp, TEMP_APP);
}

/**
	use appc cli to do the following:
		1. get the active sdk
		2. change the mobile test app (TEMP_APP) to the active sdk
		3. build (only) TEMP_APP for target platform

	@param {Array} platform - target platform to build the mobile app against
	@param {Function} done - the promise resolve function to call once the task is done
	@param {Function} bail - the promise reject function to call if there are any failures
**/
function _buildTestApp(platform, done, bail) {
	console.log('Starting build process ...');

	new Promise((resolve, reject) => {
		AppcUtil.getSDKList(resolve, reject);
	})
	.then(sdkList => {
		const activeSDK = sdkList.activeSDK;
		return activeSDK;
	})
	.then(activeSDK => {
		const tiappXmlFile = path.join(TEMP_APP, 'tiapp.xml');
		__change(tiappXmlFile, activeSDK);
	})
	.then(() => {
		return new Promise(resolve => {
			AppcUtil.buildOnly(TEMP_APP, platform, buildPrc => {
				buildPrc.stdout.on('data', prcCb);
				buildPrc.stderr.on('data', prcCb);
				buildPrc.on('exit', () => {
					resolve();
				});

				function prcCb(output) {
					console.log(output.toString().trim());
				}
			});
		});
	})
	.then(done)
	.catch(bail);

	// modify the tiapp.xml with the specified titanium sdk
	function __change(tiappXml, activeSDK) {
		let xml = fs.readFileSync(tiappXml, {encoding: 'utf8'}).trim();

		const
			oldSdkXml = xml.match(/<sdk\-version>.+<\/sdk\-version>/g)[0],
			newSdkXml = `<sdk-version>${activeSDK}</sdk-version>`;

		xml = xml.replace(oldSdkXml, newSdkXml);
		fs.writeFileSync(tiappXml, xml);
	}
}

/**
	launch the specified genymotion emulator if it is defined in your genymotion app.

	NOTE: this assumes that you have genymotion and virtualbox installed on the machine and in the default location.

	@param {String} genyDevice - the genymotion emulator used for testing
	@param {Function} done - the Promise resolve function; called only when this task is done
	@param {Function} bail - the Promise reject function; called when runtime errors appear in this promise chain
**/
function _launchGeny(genyDevice, done, bail) {
	console.log(`Launching Genymotion emulator: ${genyDevice} ...`);

	let playerPid = -1;

	new Promise((resolve, reject) => {
		let vboxManageExe = 'VBoxManage';
		if (os.platform() === 'win32') {
			// need to get absolute path to VBoxManage.exe
			vboxManageExe = path.join(process.env.VBOX_MSI_INSTALL_PATH, 'VBoxManage');
		}

		const listVmsCmd = spawn(vboxManageExe, ['list', 'vms']);

		let output = '';
		listVmsCmd.stdout.on('data', chunk => {
			output += chunk;
		});

		listVmsCmd.stderr.on('data', output => {
			console.log(output.toString());
		});

		listVmsCmd.on('exit', () => {
			const
				regExp = new RegExp(`^"${genyDevice}"`, 'm'),
				deviceExist = regExp.test(output.trim());

			// check if the specified genymotion emulator is in genymotion app
			if (!deviceExist) {
				reject(new Error(`"${genyDevice}" doesn't exist; make sure to add it in genymotion.`));
				return;
			}
			resolve();
		});
	})
	.then(() => {
		// player executable should be in the default install location (hopefully)
		const player = (os.platform() === 'win32') ?
			'C:\\Program Files\\Genymobile\\Genymotion\\player' :
			'/Applications/Genymotion.app/Contents/MacOS/player.app/Contents/MacOS/player';

		// launch genymotion emulator via player
		const flags = ['--vm-name', genyDevice];
		playerPid = spawn(player, flags).pid;
	})
	.then(() => {
		return new Promise(resolve => {
			const
				// ANDROID_HOME environment variable is required by appium, so it's okay to use it
				adbExe = path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
				// http://stackoverflow.com/questions/3634041/detect-when-android-emulator-is-fully-booted
				flags = ['shell', 'getprop', 'sys.boot_completed'],
				adbCmd = AppcUtil.spawnConvert(adbExe, flags);

			// check when the emulator is fully booted before moving forward
			isEmuBooted();
			function isEmuBooted() {
				const bootProc = spawn(adbCmd, flags);

				/*
					when the emulator is fully booted, 'getprop sys.boot_completed' will print 1 with newline.

					otherwise, it will print to stderr 'no devices/emulators are found'
					or print to stdout a whitespace, which we'll ignore.
				*/
				bootProc.stdout.on('data', out => {
					if (out.toString().trim() === '1') {
						resolve();
					} else {
						isEmuBooted();
					}
				});
				bootProc.stderr.on('data', () => {
					isEmuBooted();
				});
			}
		});
	})
	.then(() => {
		done(playerPid);
	})
	.catch(bail);
}

/**
	kills the genymotion emulator by running:
	- applescript on macOS: 'quit app "player"'
	- vbscript on Windows: look at vbScript

	if you were to send kill signals to the "player" process (from launchGeny()),
	then genymotion will not be able to handle those signals, i.e. the player process will be killed,
	but the VBox processes will still be alive and "adb devices" will persist the android emulator (both launched by "player").
	this will cause the next launch of genymotion emulator to be more likely to be unsuccessful.

	by running these external commands, they will make genymotion emulator die gracefully.

	@param {Number} playerPid - the genymotion pid
	@param {Function} done - Promise resolve function to call when this task is done
**/
function _quitGeny(playerPid, done) {
	let
		cmd = 'osascript',
		flags = ['-e', 'quit app "player"'];

	if (os.platform() === 'win32') {
		const vbScript = `
Set WshShell = WScript.CreateObject("WScript.Shell")
WshShell.AppActivate ${playerPid}
WshShell.SendKeys "%{F4}"`;

		const vbFile = path.join(__dirname, 'kill_geny.vbs');
		fs.writeFileSync(vbFile, vbScript);

		flags = [];
		cmd = AppcUtil.spawnConvert(vbFile, flags);
	}

	spawn(cmd, flags)
	.on('exit', () => {
		done();
	});
}