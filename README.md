#Lazel
Chrome extension that helps auto create Google Tasks and Calendar events using screenshots.


## how it works

- Takes a screenshot
- Figures out intent using gpt-4o-mini vision model ( task / calendar )
- Does another Openai call to extract needed JSON for the task/calendar api from google
- Calls OAuth authorized api for this


## Please note:

- You need to bring your own api-key for openai as of now
- No user data is stored or collected



## Local Dev Setup

-  Create a `manifest.json` based on `sample.manifest.json`, replacing the OAuth and Chrome store API keys.
-  Refer to:
    - [Chrome OAuth Integration](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
    - [Chrome Extensions Tutorial](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) for setup basics.

## Contact

I would love to know what you think about this. Please email me randombillionair@gmail.com.


Feel free to modify any part as needed!