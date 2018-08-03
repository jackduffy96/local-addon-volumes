'use strict';

var _TableListRepeater = require('local/renderer/components/TableListRepeater');

var _TableListRepeater2 = _interopRequireDefault(_TableListRepeater);

var _BrowseInput = require('local/renderer/components/BrowseInput');

var _BrowseInput2 = _interopRequireDefault(_BrowseInput);

var _confirm = require('local/renderer/confirm');

var _confirm2 = _interopRequireDefault(_confirm);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

const path = require('path');
const os = require('os');

module.exports = function (context) {

	const { Component, Fragment } = context.React;
	const React = context.React;
	const docker = context.docker.docker;
	const { remote } = context.electron;
	const dialog = remote.dialog;
	const sendEvent = context.events.send;

	const localPath = remote.app.getAppPath();

	const siteData = remote.require(path.join(localPath, './helpers/site-data'));
	const startSite = remote.require(path.join(localPath, './main/actions-sites/startSite'));
	const formatHomePath = remote.require('./helpers/format-home-path');

	return class SiteInfoVolumes extends Component {
		constructor(props) {
			super(props);

			this.formatDockerPath = filepath => {

				if ('win32' !== os.platform()) {
					return filepath;
				}

				const { root } = path.parse(filepath);

				return '/' + root.toLowerCase().replace(':', '').replace('\\', '/') + filepath.replace(root, '').replace(/\\/g, '/');
			};

			this.state = {
				volumes: [],
				path: null,
				provisioning: false
			};

			this.inspectContainer = this.inspectContainer.bind(this);
			this.repeatingContent = this.repeatingContent.bind(this);
			this.renderHeader = this.renderHeader.bind(this);
			this.remapVolumes = this.remapVolumes.bind(this);
		}

		componentDidMount() {

			this.inspectContainer();
		}

		inspectContainer() {

			let siteID = this.props.params.siteID;
			let site = this.props.sites[siteID];

			docker().getContainer(site.container).inspect((err, containerInfo) => {

				let containerVolumes = [];

				containerInfo.Mounts.forEach(mount => {
					let source = 'win32' === os.platform() ? path.resolve(mount.Source.replace('/c/', '/')) : mount.Source;
					containerVolumes.push({ source: source, dest: mount.Destination });
				});

				this.setState({
					path: containerInfo.Path,
					volumes: containerVolumes
				});
			});
		}

		getPorts() {

			return new Promise(resolve => {

				let siteID = this.props.params.siteID;
				let site = this.props.sites[siteID];

				docker().getContainer(site.container).inspect((err, containerInfo) => {

					let containerPorts = [];

					try {

						Object.keys(containerInfo.NetworkSettings.Ports).forEach(port => {

							let portInfo = containerInfo.NetworkSettings.Ports[port][0];

							containerPorts.push({ hostPort: portInfo.HostPort, containerPort: port.replace('/tcp', '') });
						});
					} catch (e) {
						console.warn(e);
					}

					resolve(containerPorts);
				});
			});
		}

		remapVolumes(volumes) {

			let siteID = this.props.params.siteID;
			let site = this.props.sites[siteID];
			let errors = [];

			volumes.forEach(volume => {

				if (!volume.source.trim() || !volume.dest.trim()) {
					return errors.push('Empty source or destination.');
				}

				if ('win32' === os.platform()) {
					if (formatHomePath(volume.source).indexOf('C:\\Users') !== 0) {
						return errors.push('Path does not start with C:\\Users');
					}
				} else {
					if (volume.source.indexOf('/') !== 0 || volume.dest.indexOf('/') !== 0) {
						return errors.push('Path does not start with slash.');
					}

					if (formatHomePath(volume.source).indexOf('/Users') !== 0 && formatHomePath(volume.source).indexOf('/Volumes') !== 0) {
						return errors.push('Path does not start with /Users or /Volumes');
					}
				}
			});

			if (errors.length) {

				return dialog.showErrorBox('Invalid Paths Provided', `Sorry! There were invalid paths provided.

Please ensure that all paths have a valid source and destination.

Also, all source paths must begin with either /Users or /Volumes.`);
			}

			let choice = dialog.showMessageBox(remote.getCurrentWindow(), {
				type: 'question',
				buttons: ['Cancel', 'Remap Volumes'],
				title: 'Confirm',
				message: `Are you sure you want to remap the volumes for this site? There may be inadvertent effects if volumes aren't mapped correctly.

Last but not least, make sure you have an up-to-date backup.

There is no going back after this is done.`
			});

			if (choice === 0) {
				return;
			}

			this.setState({
				volumes,
				provisioning: true
			});

			sendEvent('updateSiteStatus', siteID, 'provisioning');

			docker().getContainer(site.container).commit().then(image => {

				let oldSiteContainer = site.container;

				this.getPorts().then(ports => {

					docker().getContainer(site.container).kill().then(() => {

						const exposedPorts = {};
						const portBindings = {};

						ports.forEach(port => {
							exposedPorts[`${port.containerPort}/tcp`] = {};

							portBindings[`${port.containerPort}/tcp`] = [{
								'HostPort': port.hostPort.toString()
							}];
						});

						docker().createContainer({
							'Image': image.Id,
							'Cmd': this.state.path,
							'Tty': true,
							'ExposedPorts': exposedPorts,
							'HostConfig': {
								'Binds': this.state.volumes.map(volume => {
									let source = this.formatDockerPath(volume.source);
									return `${formatHomePath(source)}:${volume.dest}`;
								}),
								'PortBindings': portBindings
							}
						}).then(container => {

							site.container = container.id;

							let clonedImages = [];

							if ('clonedImage' in site) {
								if (typeof site.clonedImage === 'string' && site.clonedImage) {
									clonedImages = [site.clonedImage];
								} else if (Array.isArray(site.clonedImage)) {
									clonedImages = [...site.clonedImage];
								}
							}

							clonedImages.push(image.Id);

							site.clonedImage = clonedImages;
							siteData.updateSite(siteID, site);

							startSite(site).then(() => {
								sendEvent('updateSiteStatus', siteID, 'running');

								this.setState({
									provisioning: false
								});

								context.notifier.notify({
									title: 'Volumes Remapped',
									message: `Volumes for ${site.name} have been remapped.`
								});
							});

							docker().getContainer(oldSiteContainer).remove();
						});
					});
				});
			});
		}

		renderHeader() {
			return React.createElement(
				Fragment,
				null,
				React.createElement(
					'strong',
					null,
					'Host Source'
				),
				React.createElement(
					'strong',
					{ className: '--SeparatorLeft' },
					'Container Destination'
				)
			);
		}

		repeatingContent(volume, index, updateItem) {

			const siteID = this.props.params.siteID;
			const site = this.props.sites[siteID];

			return React.createElement(
				Fragment,
				null,
				React.createElement(
					'div',
					null,
					React.createElement(_BrowseInput2.default, { placeholder: 'Host Source', defaultPath: site.path, value: volume.source,
						dialogTitle: 'Choose Host Source',
						dialogProperties: ['openDirectory', 'createDirectory', 'openFile'],
						onChange: value => {
							volume.source = value;
							updateItem(volume);
						} })
				),
				React.createElement(
					'div',
					{ className: '--SeparatorLeft --Input' },
					React.createElement('input', { type: 'text', value: volume.dest, placeholder: 'Container Destination', onChange: e => {
							volume.dest = e.target.value;
							updateItem(volume);
						} })
				)
			);
		}

		beforeRemove(volume, index) {
			return _asyncToGenerator(function* () {

				yield (0, _confirm2.default)({
					title: React.createElement(
						'span',
						null,
						'Are you sure you want to remove this volume? This may cause your site to not function properly.'
					),
					buttonText: 'Remove Volume',
					buttonClass: '--Red'
				});

				return true;
			})();
		}

		render() {

			return React.createElement(
				'div',
				{ className: '--Panel' },
				React.createElement(_TableListRepeater2.default, { repeatingContent: this.repeatingContent, header: this.renderHeader(),
					itemTemplate: { source: '', dest: '' }, onSubmit: this.remapVolumes,
					data: this.state.volumes, onBeforeRemove: this.beforeRemove,
					submitDisabled: this.state.provisioning || this.props.siteStatus !== 'running',
					submitLabel: this.state.provisioning ? 'Remapping Volumes...' : this.props.siteStatus === 'running' ? 'Remap Volumes' : 'Start Site to Remap Volumes' })
			);
		}
	};
};
