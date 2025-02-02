import { sleep, pathToRootOfTree } from './utils.js';
import { E131Output, WebSocketOutput, sendFrame } from './output.js';
import { Model } from './model.js';
import { default as fs } from 'fs';
import { readFile } from 'fs/promises';
import { default as tmp } from 'tmp';
tmp.setGracefulCleanup();
import { default as path } from 'path';
import { default as child_process } from 'child_process';
import { default as toml } from 'toml';

/*****************************************************************************/
/* Old patterns                                                              */
/*****************************************************************************/

/* Karen's patterns - to be ported back to Python
class LinearTopToBottomPattern {
  get(frame) {
    let layer = new Layer(frame.model);
    let threshold = 1 - frame.displayTime/5 % 1; 
    let topZ = frame.model.center()[2] * 2;
    let lightEndZ = threshold * topZ;
    frame.model.edges.forEach(edge => {
      let colorTemplate = [255,255,255]; // TODO: add colors 
      edge.pixels.forEach(pixel => {
        if (pixel.z > lightEndZ) {
          let brightness = 1 - (pixel.z - lightEndZ) / ( topZ/3 );
          if (brightness > 0) {
            let color = colorTemplate.map(x => x * brightness);
            layer.setRGB(pixel, color);
          }
        }
      })
    })
    return layer;
  }
}


class LinearRandomWalkPattern{
  // TODO: ideally the tail of each light can be seen on previous edge (real fading effect) 

  constructor(number){
    this.number = number; // number of light particles flowing around
    this.edgeIndices =  Array.from({length: this.number}, () => Math.floor(Math.random() * this.number)); //random starting edges
    this.directions = Array(this.number).fill("down"); 
  }
  get(frame) {
    let layer = new Layer(frame.model);
    for (let p = 0; p < this.number; p++){
      let currEdge = frame.model.edges[this.edgeIndices[p]];
      let threshold = (frame.displayTime  ) % 1; // precentage of the edge that will have color
      let brightestPixelIndex = Math.ceil(threshold * currEdge.pixels.length);
      let colorTemplate = [255,255,255]; //TODO: add colors
      for (let i = 0; i < brightestPixelIndex; i++) {
        let brightness = i / brightestPixelIndex; // 0 to 1 for fading effect 
        let color = colorTemplate.map(x => x * brightness);
        if (this.directions[p] == "down") {
          layer.setRGB(currEdge.pixels[i], color);
        }
        else{
          layer.setRGB(currEdge.pixels[currEdge.pixels.length-1-i], color);
        }
      }

      if (brightestPixelIndex == currEdge.pixels.length){ //find a neighbor edge to be the next edge
        let currentPoint = this.directions[p] == "down" ? currEdge.endNode.point : currEdge.startNode.point;
        let nextEdgesDown = frame.model.edges.filter(edge => edge.startNode.point === currentPoint && edge.id != currEdge.id);
        let nextEdgesUp = frame.model.edges.filter(edge => edge.endNode.point === currentPoint && edge.id != currEdge.id);
        if (nextEdgesDown.length == 0 && nextEdgesUp.length == 0) { // reset to 0
          this.edgeIndices[p] = 0;
        }
        else{ // choose a random neighbor
          const random = Math.floor(Math.random() * (nextEdgesDown.length + nextEdgesUp.length));
          if (random >= nextEdgesDown.length) {
            this.edgeIndices[p] = nextEdgesUp[random - nextEdgesDown.length].id; 
            this.directions[p] = "up"
          }
          else{
            this.edgeIndices[p] = nextEdgesDown[random].id; 
            this.directions[p] = "down"
          }
          // console.log("curr edge id:", currEdge.id , "next edge id: ", this.edgeIndex, "direction: ", this.direction)
        }
      }


    }
    
    return layer;
  }
}
*/

/*****************************************************************************/
/* Instruments (external pattern generator programs)                         */
/*****************************************************************************/

class Instrument {
  // model: a Model to pass to the instrument
  // framesPerSecond: the fps to tell the instrument to render at
  // program: eg 'node', 'python'.. should be in $PATH
  // args: string array of arguments
  constructor(model, framesPerSecond, program, args) {
    const totalPixels = model.pixelCount();
    const frameSize = 4 + 4 * totalPixels;

    const toolConfiguration = {
      framesPerSecond: framesPerSecond,
      model: model.export(),
    };
  
    const tmpobj = tmp.fileSync();
    fs.writeSync(tmpobj.fd, JSON.stringify(toolConfiguration));

    this.child = child_process.spawn(program, [...args, tmpobj.name]);
    console.log(tmpobj.name);
    this.child.on('close', (code) => {
      // XXX handle this?
      console.log(`child process exited with code ${code}`);
    });
    this.child.on('error', (err) => {
      // XXX handle this
      console.log('Failed to start subprocess.');
    });

    this.child.stderr.pipe(process.stderr); // XXX revisit later? at least break it into lines and prefix it?
  
    // if needed for performance, could rewrite this to reduce the number of copies
    // (keep the incoming buffers in an array, and copy out to a buffer, sans frame number, in getFrame())
    async function* packetize(stream) {
      let childBuf = Buffer.alloc(0);
  
      for await (const buf of stream) {
        childBuf = Buffer.concat([childBuf, buf]);
        while (childBuf.length >= frameSize) {
          let frameData = childBuf.subarray(0, frameSize);
          childBuf = childBuf.subarray(frameSize);
          yield frameData;
        }
      }
    }
  
    this.childPacketIterator = packetize(this.child.stdout)[Symbol.asyncIterator]();
  }

  // XXX make it take the wanted frame nummber?
  async getFrame() {
    let item = await this.childPacketIterator.next();
    if (item.done)
      return null; // and perhaps make clean/error exit status available on anotehr method?
    else
      return item.value;
  }
}


/*****************************************************************************/
/* Simulator                                                                 */
/*****************************************************************************/

import { application, default as express } from 'express';

class Simulator {
  constructor(config, model) {
    this.model = model;
    this.port = config.port || 3000;
    this.webSocketPort = config.webSocketPort || this.port + 1;
    this._app = express();

    // Serve static assets
    this._app.use(express.static(path.join(pathToRootOfTree(), 'web')));
  
    // API
    this._app.get('/api/config', (req, res) => {
      const config = {
        webSocketPort: this.webSocketPort,
        model: this.model.export()
      };
      return res.send(JSON.stringify(config));
    });
  
    // Start the server
    this._app.listen(this.port, () => {
      console.log(`Web interface on http://localhost:${this.port}`)
    })
  
  }
}

/*****************************************************************************/
/* Main loop                                                                 */
/*****************************************************************************/

async function main() {
  // XXX take config file as command line argument
  const configPath = path.join(pathToRootOfTree(), 'config.toml');
  const configDir = path.dirname(configPath);
  const config = toml.parse(await readFile(configPath));

  const model = Model.import(JSON.parse(await readFile(path.join(configDir, config.model))));
  const simulator = config.simulator ? new Simulator(config.simulator, model) : null;

  let framesPerSecond = config.framesPerSecond;
  let msPerFrame = 1000.0 / framesPerSecond;

  const outputs = [];
  if (simulator)
    outputs.push(new WebSocketOutput(simulator.webSocketPort));
  for (const outputConfig of (config.outputs || [])) {
    switch (outputConfig.type) {
      case 'e131':
        outputs.push(new E131Output(outputConfig.host, outputConfig.channels));
        break;
      default:
        throw new Error(`Unknown output type '${outputConfig.type}'`);
    }
  }

  // let instrument = new Instrument(model, framesPerSecond, 'node', [path.join(pathToRootOfTree(), 'patterns', 'rainbow-spot.js')]);
  let instrument = new Instrument(model, framesPerSecond, 'python3', [path.join(pathToRootOfTree(), 'patterns', 'top_down_white.py')]);

  let lastFrameIndex = null;
  let startTime = Date.now();

  const pixelColorsMixed = [];
 
  while (true) {
    // We should redo this at some point so that displayTime is actually the time the frame's
    // going to be displayed (for music sync purposes). Currently it's actually the time the
    // frame is rendered.
    // XXX disregard above and rewrite this for new tool model
    let msSinceStart = (Date.now() - startTime);
    let frameIndex = Math.floor(msSinceStart / msPerFrame) + 1;
    let displayTimeMs = startTime + frameIndex * msPerFrame;
    await sleep(displayTimeMs - Date.now());

    // Clear out the mixer framebuffer to black
    for (let i = 0; i < model.pixelCount(); i ++)
      pixelColorsMixed[i] = [0, 0, 0];

    let frameData = await instrument.getFrame();
    if (! frameData) {
      console.log(`pattern exited`);
      break;
    }
//    console.log(frameData);

    // XXX check frame number, loop until we catch up, bail out if we fall too far behind
    for (let i = 0; i < model.pixelCount(); i ++) {
      let r = frameData.readUint8(4 + i * 4 + 0);
      let g = frameData.readUint8(4 + i * 4 + 1);
      let b = frameData.readUint8(4 + i * 4 + 2);
      let a = frameData.readUint8(4 + i * 4 + 3);
      pixelColorsMixed[i] = [r, g, b]; // TODO: mix layers :)
    }

    await sendFrame(pixelColorsMixed, outputs);

    if (lastFrameIndex !== null && lastFrameIndex !== frameIndex - 1) {
      console.log(`warning: skipped frames from ${lastFrameIndex} to ${frameIndex}`);
    }
    lastFrameIndex = frameIndex;
  }
}

await main();

// XXX mixer notes:
// new_value = pixel * alpha + old_value * (1 - alpha)
//
// effective_alpha = pixel_alpha * layer_alpha
// new_value = pixel * effective_alpha + old_value * (1 - effective_alpha)
//
// From backmost layer to frontmost layer
// You can avoid divisions by doing one rescale per layer (which can be a multiplication)
// At the end you get a double per LED channel which you could gamma correct if desired