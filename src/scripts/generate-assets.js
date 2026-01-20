const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// Ensure ffmpeg path is set (assuming standard installation or environment variable)
// If in Electron dev, might need specific path logic, but for script run:
const ffmpegPath = 'ffmpeg'; // Or full path if needed
ffmpeg.setFfmpegPath(ffmpegPath);

const ASSETS_DIR = path.join(__dirname, '../renderer/assets/cta');
const OUTPUT_DIR = ASSETS_DIR;

// Generation Configurations
const TASKS = [
    {
        name: 'like_classic',
        input: 'like_classic.png',
        duration: 3,
        // zoom in-out effect
        filter: "zoompan=z='min(zoom+0.0015,1.5)':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=200x200,fade=t=in:st=0:d=0.5:alpha=1,fade=t=out:st=2.5:d=0.5:alpha=1",
        soundFreq: 800
    },
    {
        name: 'sub_red',
        input: 'sub_red_sprite.png',
        duration: 4,
        // Pulse effect using scale
        filter: "scale=iw*1.1:ih*1.1:eval=frame,zoompan=z='if(lte(mod(on,60),30),zoom+0.002,zoom-0.002)':d=200:s=300x100,fade=t=in:st=0:d=0.5:alpha=1",
        soundFreq: 600
    },
    {
        name: 'bell_shake',
        input: 'bell_shake_sprite.png',
        duration: 3,
        // Shake effect (rotate)
        filter: "rotate=a='0.1*sin(2*PI*t*5)':ow=iw:oh=ih:c=none,fade=t=in:st=0:d=0.5:alpha=1",
        soundFreq: 1200
    },
    {
        name: 'share_arrow',
        input: 'share_arrow_sprite.png',
        duration: 3,
        // Slide in from left
        filter: "fade=t=in:st=0:d=0.5:alpha=1",
        soundFreq: 1000
    }
];

async function generateAsset(task) {
    const inputPath = path.join(ASSETS_DIR, task.input);
    const outputPath = path.join(OUTPUT_DIR, `${task.name}.webm`);

    console.log(`Generating ${task.name}...`);

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        return;
    }

    // Create a complex filter chain
    // 1. Image input -> loop
    // 2. Audio input -> sine wave

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(inputPath)
            .inputOptions([
                '-loop 1',
                '-framerate 30'
            ])
            // Audio: Sine wave beep at start
            .input(`anullsrc=channel_layout=stereo:sample_rate=44100`)
            .inputOptions(['-f lavfi'])
            // Add actual sound effect using lavfi sine
            // We'll map a generated sine wave 
            .complexFilter([
                // Video Filters
                `[0:v]format=yuva420p,scale=300:-1[vbase]`, // Base processing
                `[vbase]${task.filter}[vout]`,

                // Audio Filters: Simple "pop" sound
                `sine=f=${task.soundFreq}:d=0.2[beep]`,
                `[beep]adelay=500|500[aout]` // Delay 0.5s
            ])
            .outputOptions([
                '-map [vout]',
                '-map [aout]',
                '-c:v libvpx-vp9',
                '-pix_fmt yuva420p', // Important for alpha
                '-auto-alt-ref 0', // Transparency fix attempt
                '-c:a libvorbis',
                `-t ${task.duration}`
            ])
            .output(outputPath)
            .on('end', () => {
                console.log(`Finished: ${task.name}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error generating ${task.name}:`, err);
                reject(err);
            })
            .run();
    });
}

(async () => {
    try {
        for (const task of TASKS) {
            await generateAsset(task);
        }
        console.log('All assets generated successfully!');
    } catch (error) {
        console.error('Asset generation failed:', error);
    }
})();
