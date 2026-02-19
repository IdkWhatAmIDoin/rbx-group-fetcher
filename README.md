# rblx user info fetcher
thing i made that gets someone's info. you would never need this but its really just for me

# uh api thing
the url is https://rbx-group-fetcher.dimasuperotovorot3000.workers.dev/ and this should be the body  
{  


  "username": "PapaAleks11", 

  
  "groupId": 33421625,  

  
  "includeAvatar": true,  

  
  "includePresence": true,  

  
  "includeFriendsCount": true  

  
} 
it also supports user ids instead of usernames  
group id, includeavatar includepresence includefriendscount and everything else that is in the code is optional, defaults to false  
the api should return something like this  
{


  "id": 1478795848,  

  
  "name": "PapaAleks11",  

  
  "displayName": "Dima",  

  
  "description": "oh hi!",  

  
  "created": "2006-03-08T16:34:00.613Z",  

  
  "isBanned": false,  

  
  "externalAppDisplayName": null,  

  
  "groupContext": {  

  
    "rank": 255,  

    
    "role": "Owner"  

    
  }  

  
}
i wont update this example for a while so it will definitely differ

# uh thats it
bye



