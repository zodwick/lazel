let token = null;
let screenshotDataUrl = ""; // Variable to hold the screenshot data URL

window.onload = function () {
  // Load the token from storage
  chrome.storage.sync.get("token", function (data) {
    if (chrome.runtime.lastError) {
      writeError("Error loading token:", chrome.runtime.lastError);
    } else {
      token = data.token;
      console.log("Token loaded:", token);
    }
  });

  function writetoResultScreen(text, color = "") {
    document.getElementById("analysisResult").innerText = text;
    if (color) {
      document.getElementById("analysisResult").style.color = color;
    }
  }

  function writeError(text) {
    document.getElementById("analysisResult").innerText = text;
    // set the text color to red
    document.getElementById("analysisResult").style.color = "red";
  }

  // Update the login button event listener
  document
    .getElementById("AnalyseButton")
    .addEventListener("click", async function () {
      chrome.identity.getAuthToken(
        { interactive: true },
        async function (newToken) {
          token = newToken; // Store the token globally
          if (!token) {
            writeError("Error acquiring token.");
            return;
          }

          try {
            await takeScreenshot(); // Wait for screenshot to complete
            await analyseScreenshot(); // Now analyze the screenshot

            chrome.storage.sync.set({ token: token }, function () {
              console.log("Token saved:", token);
            });
          } catch (error) {
            writeError("Error during screenshot or analysis:", error);
          }
        }
      );
    });
  // Handle OpenAI API Key submission
  document
    .getElementById("apiKeyForm")
    .addEventListener("submit", function (event) {
      event.preventDefault(); // Prevent form submission
      const apiKey = document.getElementById("apiKeyInput").value;
      chrome.storage.sync.set({ openaiApiKey: apiKey }, function () {
        console.log("OpenAI API Key saved:", apiKey);
      });
    });

  function compressImage(dataUrl, quality = 0.5, maxWidth = 1920) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = function () {
        // Calculate new dimensions while maintaining aspect ratio
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = (maxWidth * height) / width;
          width = maxWidth;
        }

        // Create canvas
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        // Draw and compress image
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        // Convert to compressed data URL
        const compressedDataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(compressedDataUrl);
      };

      img.onerror = function () {
        reject(new Error("Failed to load image"));
      };

      img.src = dataUrl;
    });
  }

  // Modified takeScreenshot function
  async function takeScreenshot() {
    writetoResultScreen("Taking screenshot...");
    return new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(null, {}, async function (dataUrl) {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }

        try {
          // Compress the screenshot
          const compressedDataUrl = await compressImage(dataUrl);
          screenshotDataUrl = compressedDataUrl; // Store the compressed screenshot

          resolve(compressedDataUrl);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  // Helper function to remove the first and last lines from the response
  function removeFirstLastLines(data) {
    const lines = data.split("\n");
    return lines.slice(1, -1).join("\n");
  }

  async function addTaskList(token, taskListName) {
    const reqBody = {
      title: taskListName,
    };

    try {
      const response = await fetch(
        "https://tasks.googleapis.com/tasks/v1/users/@me/lists",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(reqBody),
        }
      );
      if (response.ok) {
        const task_details = await response.json();
        const taskListId = task_details.id;
        return taskListId;
      }
    } catch (error) {
      writeError("Error creating task list:", error);
    }
  }

  async function getTaskLists(token, maxResults = 20, pageToken = "") {
    if (!token) {
      console.log("Please log in first.");
      return;
    }
    const url = new URL(
      "https://tasks.googleapis.com/tasks/v1/users/@me/lists"
    );
    const params = { maxResults, pageToken };

    // Append query parameters to the URL
    Object.keys(params).forEach(
      (key) => params[key] && url.searchParams.append(key, params[key])
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log("Task Lists:", data);
      return data.items;
    } catch (error) {
      writeError("Fetch error:", error);
    }
  }

  async function createTask(token, task_title, taskListId) {
    if (!token) {
      console.log("Please log in first.");
      return;
    }

    const taskbody = {
      title: task_title,
    };
    try {
      const response = await fetch(
        `https://tasks.googleapis.com/tasks/v1/lists/${taskListId}/tasks`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(taskbody),
        }
      );

      if (response.ok) {
        const eventData = await response.json();
        console.log("Event created:", eventData);
        return eventData; // Return created event data
      } else {
        writeError("Failed to create event:", await response.text());
      }
    } catch (error) {
      writeError("Error creating event:", error);
    }
  }

  async function secondAICall(jsonData, apiKey) {
    if (!jsonData.type || !jsonData.Details) {
      writeError("Invalid JSON format");
      document.getElementById("analysisResult").innerText =
        "Could not find an intent";
      return;
    }

    if (jsonData.type !== "event" && jsonData.type !== "task") {
      writeError("No relevant entry found.");
      return;
    }

    writetoResultScreen(`creating ${jsonData.type}..`);
    if (jsonData.type === "event") {
      const date_time_iso = new Date().toISOString();
      const day = new Date().toLocaleString("en-US", { weekday: "short" });
      // Prepare payload for structured extraction request

      const jsonSchemaCalender = {
        type: "json_schema",
        json_schema: {
          name: "event_schema",
          strict: false,
          schema: {
            type: "object",
            required: ["summary", "start", "end"],
            properties: {
              end: {
                type: "object",
                required: ["dateTime", "timeZone"],
                properties: {
                  dateTime: {
                    type: "string",
                    description: "The date and time the event ends.",
                  },
                  timeZone: {
                    type: "string",
                    description: "The timezone of the event.",
                  },
                },
                description: "The end time of the event.",
                additionalProperties: false,
              },
              start: {
                type: "object",
                required: ["dateTime", "timeZone"],
                properties: {
                  dateTime: {
                    type: "string",
                    description: "The date and time the event starts.",
                  },
                  timeZone: {
                    type: "string",
                    description: "The timezone of the event.",
                  },
                },
                description: "The start time of the event.",
                additionalProperties: false,
              },
              status: {
                enum: ["confirmed", "tentative", "cancelled"],
                type: "string",
                description: "Current status of the event.",
              },
              summary: {
                type: "string",
                description: "A brief summary of the event.",
              },
              location: {
                type: "string",
                description: "Location where the event will take place.",
              },
              attendees: {
                type: "array",
                items: {
                  type: "object",
                  required: ["email"],
                  properties: {
                    email: {
                      type: "string",
                      description: "Email address of the attendee.",
                    },
                    optional: {
                      type: "boolean",
                      description: "Indicates if the attendee is optional.",
                    },
                    displayName: {
                      type: "string",
                      description: "Display name of the attendee.",
                    },
                    responseStatus: {
                      enum: [
                        "needsAction",
                        "declined",
                        "tentative",
                        "accepted",
                      ],
                      type: "string",
                      description: "Response status of the attendee.",
                    },
                  },
                  additionalProperties: false,
                },
                description: "List of attendees for the event.",
              },
              visibility: {
                enum: ["default", "public", "private", "confidential"],
                type: "string",
                description: "Visibility level of the event.",
              },
            },
            additionalProperties: false,
          },
        },
      };

      const payload = {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: ` You are given the summary of an event that needs to be added to the calendar of an user. There is no human in the loop to provide additional information. \n\nPlease do not assume any information. Only use emails, name, location and other info from the summary given to you and do not use examples / placeholders .\n\n\ncurrent date-time is ${date_time_iso} and is a ${day}  \n\n----------\nSUMMARY\n_________\n\n ${jsonData.Details} \n\n----------\n remember, do not use example email adresses as the system sends out invites to these emails. Leave the attendees as empty if there are no email adresses found. \n`,
              },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 2048,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        response_format: jsonSchemaCalender,
      };

      try {
        const response = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`, // use OpenAI API key from storage
            },
            body: JSON.stringify(payload),
          }
        );

        if (response.ok) {
          const structuredData = await response.json();
          console.log("Structured Event Data:", structuredData);
          writetoResultScreen("Almost done..");
          // Proceed with calendar event creation here using structuredData
          await createCalendarEvent(
            token,
            JSON.parse(structuredData.choices[0].message.content)
          );
          writetoResultScreen("Event created successfully", "green");
        } else {
          writeError("Failed structured extraction:", await response.text());
        }
      } catch (error) {
        writeError("Error in structured extraction:", error);
      }
    }

    if (jsonData.type == "task") {
      // add the task here
      writetoResultScreen("Creating Task..");
      const currentTaskList = await getTaskLists(token); // array of task lists
      const TaskListNames = currentTaskList.map((taskList) => taskList.title);

      const json_schema_task = {
        type: "json_schema",
        json_schema: {
          name: "task_generation",
          strict: false,
          schema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "The title of the task to be generated.",
              },
              taskListName: {
                type: "string",
                description:
                  "The name of the task list where the task will be added.",
              },
            },
            required: ["title", "taskListName"],
            additionalProperties: false,
          },
        },
      };

      const payload = {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: ` You are given the summary of a task that needs to be added to the task app of an user. You are also given a list of the current lists the user has in his task app. Either choose one of these or create a new list as per the summary. If possible prefer choose an existing one.\n\n  \n\n----------\nSUMMARY\n_________\n\n ${
                  jsonData.Details
                } \n\n----------\n \n \n ----------------\n Current Task Lists\n ----------------\n\n ${TaskListNames.join()} \n\n`,
              },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 2048,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        response_format: json_schema_task,
      };

      try {
        const response = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`, // use OpenAI API key from storage
            },
            body: JSON.stringify(payload),
          }
        );

        if (response.ok) {
          const structuredData = await response.json();
          console.log("Structured Event Data:", structuredData);
          writetoResultScreen("Almost done..Lemme find your task lists");

          const taskList = JSON.parse(
            structuredData.choices[0].message.content
          );
          const taskListName = taskList.taskListName;
          const task_title = taskList.title;

          // Check if the task list already exists
          if (TaskListNames.includes(taskListName)) {
            const taskListId = currentTaskList.find(
              (taskList) => taskList.title === taskListName
            ).id;
            await createTask(token, task_title, taskListId);
            writetoResultScreen("Task created successfully", "green");
          }
          // Create a new task list if it doesn't exist
          else {
            const taskListId = await addTaskList(token, taskListName);
            await createTask(token, task_title, taskListId);
            writetoResultScreen("Task created successfully");
          }
        } else {
          writeError("Failed structured extraction:", await response.text());
        }
      } catch (error) {
        writeError("Error in structured extraction:", error);
      }
    }
  }

  async function analyseScreenshot() {
    writetoResultScreen("Analyzing screenshot...");
    const apiKey = (await chrome.storage.sync.get("openaiApiKey")).openaiApiKey;

    if (!screenshotDataUrl) {
      writeError("Please take a screenshot first.");
      return;
    }
    if (!apiKey) {
      writeError("Please enter your OpenAI API Key first.");
      return;
    }

    if (apiKey && screenshotDataUrl) {
      writetoResultScreen("Identifyin intent...");
      // Prepare the request payload
      const payload = {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `You are given a screenshot of a website. 
                The user wishes to create a calendar event / task based on the information present in the screenshot.
                If yes, please provide the detailed summary of the event / task to be created. 
                The output should be a JSON with keys 'type' and 'Details'.

                'type' can be either 'event' or 'task' or null if no relevant entry is found.
                'Details' should contain the summary of the event / task with all relevant info. Return null if no relevant info is found.

                sample output:
                {
                  "type": "event",
                  "Details": "Meeting with John at 10:00 AM"
                }
                `,
              },
              {
                type: "image_url",
                image_url: {
                  url: screenshotDataUrl, // Use the screenshot data URL directly
                },
              },
            ],
          },
        ],
        max_tokens: 300,
        temperature: 0,
      };

      // Make the API call to OpenAI

      try {
        const response = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
          }
        );

        if (!response.ok) {
          writeError("Failed to analyze screenshot. Please try again.");
          console.error("OpenAI API Error:", await response.text());
          return;
        }

        const result = await response.json();
        console.log("Analysis Result:", result);

        let choice_1;
        try {
          // First attempt to parse JSON directly
          choice_1 = JSON.parse(result.choices[0].message.content);
          await secondAICall(choice_1, apiKey);
        } catch (parsingError) {
          // Attempt fallback by trimming the JSON string
          try {
            const trimmedChoice = removeFirstLastLines(
              result.choices[0].message.content
            );
            const output = JSON.parse(trimmedChoice);
            await secondAICall(output, apiKey);
          } catch (trimError) {
            writeError("Could not find an intent", trimError);
          }
        }
      } catch (error) {
        writeError("Error communicating with OpenAI.");
        console.error("Error in structured extraction:", error);
      }
    }
  }
};
