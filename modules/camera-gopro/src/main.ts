import { runDriver } from '@streamhub/camera-sdk';
import { GoProDevice } from './gopro';

runDriver((camera, report) => new GoProDevice(camera, report));
