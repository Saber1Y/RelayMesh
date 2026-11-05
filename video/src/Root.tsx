import { Composition } from "remotion";
import { DURATION, FPS, Intro } from "./Intro";

export function Root() {
  return (
    <>
      <Composition id="Intro" component={Intro} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} defaultProps={{ withVoiceover: true }} />
      <Composition id="IntroSquare" component={Intro} durationInFrames={DURATION} fps={FPS} width={1080} height={1080} defaultProps={{ withVoiceover: true }} />
      <Composition id="IntroVertical" component={Intro} durationInFrames={DURATION} fps={FPS} width={1080} height={1920} defaultProps={{ withVoiceover: true }} />
    </>
  );
}
