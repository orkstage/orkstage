use std::io::Read;

use serde_json::{Value, json};

use super::client;
use crate::api::ApiClient;
use crate::cli::LoginArgs;
use crate::config::{Ctx, load_user_config, normalize_url, save_user_config};
use crate::credentials;
use crate::error::{CliError, Result};
use crate::output::{self, heading};

pub async fn login(ctx: &Ctx, args: LoginArgs) -> Result<()> {
    let api_url = match ctx.api_url.clone() {
        Some(u) => u,
        None if ctx.interactive => {
            let u: String = dialoguer::Input::new()
                .with_prompt("OrkStage API URL")
                .interact_text()
                .map_err(|e| CliError::failed(e.to_string(), None))?;
            normalize_url(&u)
        }
        None => return Err(ctx.require_api_url().unwrap_err()),
    };
    if url::Url::parse(&api_url).is_err() {
        return Err(CliError::usage(
            format!("{api_url:?} is not a valid URL"),
            Some("use e.g. https://orkstage.example.com".into()),
        ));
    }
    let token = if args.with_token {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map_err(|e| CliError::io("reading the token from stdin", e))?;
        s.trim().to_string()
    } else if let Some(t) = &ctx.token_override {
        t.clone()
    } else if ctx.interactive {
        dialoguer::Password::new()
            .with_prompt(format!("API key for {api_url}"))
            .interact()
            .map_err(|e| CliError::failed(e.to_string(), None))?
    } else {
        return Err(CliError::usage(
            "no API key given",
            Some("pipe it with `--with-token`, pass --token or set ORK_TOKEN (stdin is not a terminal)".into()),
        ));
    };
    if !token.starts_with("ork_") {
        return Err(CliError::usage(
            "that does not look like an OrkStage API key (expected ork_live_… or ork_test_…)",
            None,
        ));
    }

    let me: Option<Value> =
        if args.no_verify { None } else { Some(ApiClient::new(&api_url, &token)?.get("/me", &[]).await?) };
    let store = credentials::save(&api_url, &token)?;
    let mut user = load_user_config()?;
    if user.api_url.is_none() || ctx.api_url.is_some() {
        user.api_url = Some(api_url.clone());
        save_user_config(&user)?;
    }
    let who = me.as_ref().map(describe_me).unwrap_or_else(|| "(not verified)".into());
    if ctx.json() {
        output::print_json(&json!({ "apiUrl": api_url, "store": format!("{store:?}").to_lowercase(), "me": me }));
    } else {
        eprintln!("Logged in to {api_url} as {who}. Key stored in {}.", store.describe());
    }
    Ok(())
}

pub fn logout(ctx: &Ctx) -> Result<()> {
    let api_url = ctx.require_api_url()?;
    let removed = credentials::delete(&api_url)?;
    if ctx.json() {
        output::print_json(&json!({ "apiUrl": api_url, "removed": removed }));
    } else if removed {
        eprintln!("Removed the stored API key for {api_url}.");
    } else {
        eprintln!("No stored API key for {api_url}.");
    }
    Ok(())
}

fn describe_me(me: &Value) -> String {
    let email = me.pointer("/user/email").and_then(Value::as_str).unwrap_or("?");
    match me.get("apiKey").filter(|k| !k.is_null()) {
        // An API key is its own principal; the platform reports its label in place of an email.
        Some(k) => format!(
            "API key \"{}\" ({})",
            k.get("name").and_then(Value::as_str).unwrap_or("?"),
            k.get("prefix").and_then(Value::as_str).unwrap_or("?")
        ),
        None => email.to_string(),
    }
}

pub async fn whoami(ctx: &Ctx) -> Result<()> {
    let api = client(ctx)?;
    let me: Value = api.get("/me", &[]).await?;
    if ctx.json() {
        // CASL rules are noise for humans and scripts alike.
        let mut me = me;
        if let Some(o) = me.as_object_mut() {
            o.remove("rules");
        }
        output::print_json(&json!({ "apiUrl": api.api_url, "me": me }));
        return Ok(());
    }
    crate::outln!("{} {}", heading(ctx, "API:"), api.api_url);
    crate::outln!("{} {}", heading(ctx, "User:"), describe_me(&me));
    if let Some(role) = me.pointer("/user/platformRole").and_then(Value::as_str) {
        crate::outln!("{} {role}", heading(ctx, "Platform role:"));
    }
    if let Some(scopes) = me.pointer("/apiKey/scopes").and_then(Value::as_array) {
        let s: Vec<&str> = scopes.iter().filter_map(Value::as_str).collect();
        crate::outln!("{} {}", heading(ctx, "Scopes:"), s.join(", "));
    }
    let memberships = me.get("memberships").and_then(Value::as_array).cloned().unwrap_or_default();
    if !memberships.is_empty() {
        let mut t = output::table(ctx, &["TENANT", "SLUG", "ROLE"]);
        for m in memberships {
            let f = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            t.add_row(vec![f("tenantName"), f("tenantSlug"), f("role")]);
        }
        crate::outln!("{t}");
    }
    Ok(())
}
