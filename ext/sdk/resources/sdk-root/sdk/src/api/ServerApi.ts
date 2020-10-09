import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as net from 'net';
import * as byline from 'byline';
import * as mkdirp from 'mkdirp';
import * as paths from '../paths';
import * as rimrafSync from 'rimraf'
import { promisify } from 'util';
import { ApiClient, RelinkResourcesRequest, ServerRefreshResourcesRequest, ServerStartRequest, ServerStates } from "./api.types";
import { serverApi } from './events';
import { sdkGamePipeName } from './constants';
import { SystemEvent, systemEvents } from './api.events';

const rimraf = promisify(rimrafSync);


// FIXME: proper latest version fetching
const latestVersion = '2972';

function getProjectServerPath(projectPath: string): string {
  return path.join(projectPath, '.fxserver');
}

export class ServerApi {
  state: ServerStates = ServerStates.down;

  ipcServer: net.Server | null;
  ipcSocket: net.Socket | null;

  server: cp.ChildProcess | null;
  currentEnabledResourcesPaths: string[] = [];

  constructor(
    private readonly client: ApiClient,
  ) {
    systemEvents.on(SystemEvent.relinkResources, (request: RelinkResourcesRequest) => this.handleRelinkResources(request));
    systemEvents.on(SystemEvent.restartResource, (resourceName: string) => this.handleResourceRestart(resourceName));

    process.on('exit', () => {
      if (this.server) {
        this.server.kill('SIGKILL');
      }
    });

    this.client.on(serverApi.ackState, () => this.ackState());
    this.client.on(serverApi.start, (request: ServerStartRequest) => this.start(request));
    this.client.on(serverApi.stop, () => this.stop());
    this.client.on(serverApi.restartResource, (resourceName: string) => this.handleResourceRestart(resourceName));
    this.client.on(serverApi.refreshResources, (request: ServerRefreshResourcesRequest) => this.refreshResources(request));
  }

  async handleRelinkResources(request: RelinkResourcesRequest) {
    if (this.state !== ServerStates.up) {
      return;
    }

    const { projectPath, resourcesPaths, restartResourcesWithPath } = request;

    const fxserverCwd = getProjectServerPath(projectPath);
    let resourcesToRestart: string[] = [];

    if (restartResourcesWithPath) {
      resourcesToRestart = this.currentEnabledResourcesPaths
        .filter((resourcePath) => resourcePath.startsWith(restartResourcesWithPath))
        .map((resourcePath) => path.basename(resourcePath));
    }

    await this.linkResources(fxserverCwd, resourcesPaths);

    resourcesToRestart.forEach((resourceName) => {
      this.sendIpcEvent('restart', resourceName);
    });
  }

  ackState() {
    this.client.emit(serverApi.state, this.state);
  }

  stop() {
    if (this.server) {
      this.server.kill('SIGKILL');
    }
  }

  async start(request: ServerStartRequest) {
    const { projectPath, enabledResourcesPaths } = request;

    this.client.log('Starting server in', projectPath, 'with resources', enabledResourcesPaths);

    this.client.emit('server:clearOutput');

    this.toState(ServerStates.booting);

    const fxserverCwd = getProjectServerPath(projectPath);

    await mkdirp(fxserverCwd);
    await this.linkResources(fxserverCwd, enabledResourcesPaths);

    const fxserverPath = path.join(paths.serverContainer, latestVersion, 'FXServer.exe');
    const fxserverArgs = [
      '+exec', 'blank',
      '+endpoint_add_tcp', '127.0.0.1:30120',
      '+endpoint_add_udp', '127.0.0.1:30120',
      '+set', 'onesync', 'on',
      '+set', 'sv_maxclients', '64',
      '+set', 'sv_lan', '1',
      '+add_ace', 'resource.sdk-game', 'command', 'allow',
      '+ensure', 'sdk-game',
    ];

    enabledResourcesPaths.forEach((resourcePath) => {
      fxserverArgs.push('+ensure', path.basename(resourcePath));
    });

    const server = cp.execFile(
      fxserverPath,
      fxserverArgs,
      {
        cwd: fxserverCwd,
        windowsHide: true,
      },
    );

    if (!server || !server.stdout) {
      this.client.log('Server has failed to start');
      return;
    }

    await this.setupIpc();

    server.stdout.on('data', (data) => {
      this.client.log('server output:', data.toString());
      this.client.emit(serverApi.output, data.toString('utf8'));
    });

    server.on('exit', () => {
      if (this.ipcServer) {
        this.ipcServer.close();
      }

      this.server = null;

      this.toState(ServerStates.down);
    });

    server.unref();

    this.server = server;
    this.currentEnabledResourcesPaths = enabledResourcesPaths;
  }

  async refreshResources(request: ServerRefreshResourcesRequest) {
    const { projectPath, enabledResourcesPaths } = request;

    const fxserverCwd = getProjectServerPath(projectPath);

    await mkdirp(fxserverCwd);
    await this.linkResources(fxserverCwd, enabledResourcesPaths);

    this.sendIpcEvent('refresh');
  }

  async linkResources(fxserverCwd: string, resourcesPaths: string[]) {
    const resourcesDirectoryPath = path.join(fxserverCwd, 'resources');

    await rimraf(resourcesDirectoryPath);
    await mkdirp(resourcesDirectoryPath);

    const links = resourcesPaths.map((resourcePath) => ({
      source: resourcePath,
      dest: path.join(resourcesDirectoryPath, path.basename(resourcePath)),
    }));

    links.unshift({
      source: paths.sdkGame,
      dest: path.join(resourcesDirectoryPath, 'sdk-game'),
    });

    await Promise.all(
      links.map(async ({ source, dest }) => {
        try {
          await fs.promises.symlink(source, dest, 'dir');
        } catch (e) {
          this.client.log('Failed to link resource', e.toString());
        }
      }),
    );

    this.sendIpcEvent('refresh');
  }

  handleResourceRestart(resourceName: string) {
    this.client.log('Restarting resource', resourceName);

    this.sendIpcEvent('restart', resourceName);
  }

  private sendIpcEvent(eventType: string, data?: any) {
    if (!this.ipcSocket) {
      this.client.log('No ipcSocket', eventType, data);
      return;
    }

    this.client.log('Sending ipcEvent', eventType, data);

    const msg = JSON.stringify([eventType, data]) + '\n';

    this.ipcSocket.write(msg);
  }

  // IPC channel to communicate with sdk-game resources loaded in fxserver
  private async setupIpc() {
    let disposableHandlers: (() => void)[] = [];

    this.ipcServer = net.createServer();

    this.ipcServer.on('connection', (socket) => {
      this.ipcSocket = socket;

      this.client.log('IPC connection!');

      disposableHandlers.push(
        this.client.on(serverApi.ackResourcesState, () => {
          this.sendIpcEvent('state');
        }),
        this.client.on(serverApi.restartResource, (resourceName) => {
          this.sendIpcEvent('restart', resourceName);
        }),
        this.client.on(serverApi.stopResource, (resourceName) => {
          this.sendIpcEvent('stop', resourceName);
        }),
        this.client.on(serverApi.startResource, (resourceName) => {
          this.sendIpcEvent('start', resourceName);
        }),
      );

      const lineStream = byline.createStream();

      lineStream.on('data', (msg) => {
        try {
          const [type, data] = JSON.parse(msg.toString());

          switch (type) {
            case 'state': {
              return this.client.emit(serverApi.resourcesState, data);
            }
            case 'ready': {
              return this.toState(ServerStates.up);
            }
          }
        } catch (e) {
          this.client.log(`Error parsing message from sdk-game:`, msg.toString(), e);
        }
      });

      socket.pipe(lineStream);
    });

    this.ipcServer.on('close', () => {
      this.ipcServer = null;
      this.ipcSocket = null;

      // Copy to clear original immediately
      const disposeHandlersCopy = disposableHandlers;
      disposableHandlers = [];

      disposeHandlersCopy.map((disposeHandler) => disposeHandler());
    });

    this.ipcServer.listen(sdkGamePipeName);
  }

  toState(newState: ServerStates) {
    this.state = newState;
    this.ackState();
  }
}
