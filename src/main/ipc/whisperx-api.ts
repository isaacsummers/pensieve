import * as whisperx from "../domain/whisperx";

export const whisperxApi = {
  checkInstalled: async () => whisperx.checkWhisperxAvailability(),
};
